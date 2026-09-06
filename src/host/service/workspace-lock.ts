/**
 * host/service/workspace-lock.ts — 跨进程 workspace 互斥（P1-1）。
 *
 * 进程内的 Map/Promise 互斥只覆盖单个 Host；两个 Host 进程、Host 与 purge
 * 脚本、或重启交叠仍可能同时写同一 workspace 的快照仓库与账本。这里用
 * O_EXCL 锁文件实现跨进程互斥：
 *
 *   $DSH_HOME/locks/<workspace-hash>.lock  { pid, token, acquiredAt, host }
 *
 * - 持有判定：锁文件存在且 pid 存活且未超 TTL。进程崩溃后 pid 探测立即
 *   失效，下一个申请者接管并重写锁；TTL（30 分钟，远大于 git 子进程 5 分钟
 *   预算链）只作为「持锁进程挂死但 pid 被复用/仍存活」时的兜底。
 * - token 所有权：release 只删除 token 匹配的锁，避免接管误删他人新锁。
 * - 锁放在插件私有目录，不触碰用户工作区；同一进程内调用方保证不嵌套
 *   （capture / settle / undo / redo 之间已有 in-process 互斥与 FIFO 顺序）。
 */

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import process from 'node:process'
import { dirname, join } from 'pathe'
import { workspaceHash } from './git-snapshot'

/** 持锁进程挂死（pid 仍被占用）时的接管兜底预算。 */
export const LOCK_STALE_TTL_MS = 30 * 60 * 1000

/** 忙等重试间隔与总尝试上限（100 次 × 100ms ≈ 10s 等待 + 接管竞态余量）。 */
const LOCK_RETRY_DELAY_MS = 100
const LOCK_MAX_ATTEMPTS = 200

interface LockContent {
  pid: number
  token: string
  acquiredAt: string
  host: string
}

export class WorkspaceLockBusyError extends Error {
  constructor(workspaceDir: string, holder?: LockContent) {
    super(`TURNREWIND_LOCK_BUSY: ${workspaceDir} is locked by another process${holder ? ` (pid ${holder.pid})` : ''}`)
    this.name = 'WorkspaceLockBusyError'
  }
}

export interface WorkspaceLockHandle {
  release: () => void
}

function lockPathFor(rootDir: string, workspaceDir: string): string {
  return join(rootDir, 'locks', `${workspaceHash(workspaceDir)}.lock`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    // P1-5: EPERM 表示进程存在但当前用户无权发信号——视为存活，
    // 交给 TTL 兜底；ESRCH（及其他）才是真正死亡。
    if ((error as NodeJS.ErrnoException)?.code === 'EPERM')
      return true
    return false
  }
}

function readLockContent(path: string): LockContent | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockContent>
    if (typeof parsed.pid === 'number' && typeof parsed.token === 'string' && typeof parsed.acquiredAt === 'string')
      return parsed as LockContent
    return undefined
  }
  catch {
    return undefined
  }
}

function isStale(content: LockContent | undefined): boolean {
  if (!content)
    return true
  if (!pidAlive(content.pid))
    return true
  return Date.now() - Date.parse(content.acquiredAt) > LOCK_STALE_TTL_MS
}

function writeLockFile(path: string, token: string): void {
  const payload: LockContent = {
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
    host: hostname(),
  }
  // 'wx' 是互斥点：同一路径只有一个进程能创建成功。
  const fd = openSync(path, 'wx')
  try {
    writeFileSync(fd, JSON.stringify(payload))
  }
  finally {
    closeSync(fd)
  }
}

function releaseLockFile(path: string, token: string): void {
  // 只删除自己名下的锁：锁被接管后旧 token 不匹配，留着让接管者清理。
  const current = readLockContent(path)
  if (current?.token === token)
    rmSync(path, { force: true })
}

/** 异步获取：waitMs 内按 100ms 步长忙等；超时或竞态余量耗尽抛 WorkspaceLockBusyError。 */
export async function acquireWorkspaceLock(rootDir: string, workspaceDir: string, { waitMs = 0 }: { waitMs?: number } = {}): Promise<WorkspaceLockHandle> {
  const path = lockPathFor(rootDir, workspaceDir)
  mkdirSync(dirname(path), { recursive: true })
  const token = randomUUID()
  const deadline = Date.now() + waitMs
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      writeLockFile(path, token)
      // P1-5 发布竞态防护：wx 创建到内容写完之间，其他进程可能读到空文件
      // 并判 stale 接管。获锁后回读自检——token 不在（已被接管/覆盖）即
      // 视为未获锁并重试，绝不形成双持锁。
      if (readLockContent(path)?.token !== token) {
        rmSync(path, { force: true })
        continue
      }
      let released = false
      return {
        release() {
          if (released)
            return
          released = true
          releaseLockFile(path, token)
        },
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST')
        throw error
      const holder = readLockContent(path)
      if (!isStale(holder)) {
        if (holder && Date.now() < deadline) {
          await new Promise(resolvePromise => setTimeout(resolvePromise, LOCK_RETRY_DELAY_MS))
          continue
        }
        throw new WorkspaceLockBusyError(workspaceDir, holder)
      }
      // 过期/残缺锁：接管后立刻重试（rm 与 open 之间的竞态由 'wx' 仲裁）。
      rmSync(path, { force: true })
    }
  }
  throw new WorkspaceLockBusyError(workspaceDir, readLockContent(path))
}

/** 同步获取（purge CLI 等 offline 工具）：只尝试一次，忙即抛错。 */
export function acquireWorkspaceLockSync(rootDir: string, workspaceDir: string): WorkspaceLockHandle {
  const path = lockPathFor(rootDir, workspaceDir)
  if (!existsSync(dirname(path)))
    mkdirSync(dirname(path), { recursive: true })
  const token = randomUUID()
  try {
    writeLockFile(path, token)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST')
      throw error
    throw new WorkspaceLockBusyError(workspaceDir, readLockContent(path))
  }
  // P1-5: 与异步路径一致的回读自检。
  if (readLockContent(path)?.token !== token) {
    releaseLockFile(path, token)
    throw new WorkspaceLockBusyError(workspaceDir, readLockContent(path))
  }
  let released = false
  return {
    release() {
      if (released)
        return
      released = true
      releaseLockFile(path, token)
    },
  }
}

/** 在 workspace 锁内执行异步工作：获取失败抛 WorkspaceLockBusyError，成功后保证释放。 */
export async function withWorkspaceLock<T>(rootDir: string, workspaceDir: string, work: () => Promise<T>, { waitMs = 0 }: { waitMs?: number } = {}): Promise<T> {
  const handle = await acquireWorkspaceLock(rootDir, workspaceDir, { waitMs })
  try {
    return await work()
  }
  finally {
    handle.release()
  }
}
