/**
 * host/service/git-workspace.ts — 解析真实 Git worktree 的元数据（只读）。
 *
 * spawnSync 只跑本地 rev-parse 元数据查询（SYNC_GIT_TIMEOUT_MS 预算）；git 缺失
 * （ENOENT）与非 worktree 目录分别报告，调用方据此给出 TURNREWIND_GIT_UNAVAILABLE
 * 或 TURNREWIND_GIT_REQUIRED 的准确原因。宿主路径处理使用 pathe。
 */

import type { GitWorkspaceInfo } from '../types'
import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { resolve } from 'pathe'
import { SYNC_GIT_TIMEOUT_MS } from '../constants'

const MAX_OUTPUT_BYTES = 1024 * 1024

interface GitSyncResult {
  ok: boolean
  stdout?: string
  stderr?: string
  status?: number
  error?: NodeJS.ErrnoException
}

let gitExecutableMissing = false

/** git 不在 PATH 时报告真实原因（否则会把正常 worktree 误报为非 worktree）。 */
export function gitUnavailableReason(): string | undefined {
  return gitExecutableMissing
    ? 'TURNREWIND_GIT_UNAVAILABLE: the git executable was not found on PATH; file undo is disabled'
    : undefined
}

function runGitSync(workspaceDir: string, args: string[]): GitSyncResult {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: workspaceDir,
    env: { ...process.env },
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: SYNC_GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  if (result.error)
    return { ok: false, error: result.error }
  if (result.status !== 0)
    return { ok: false, stderr: String(result.stderr ?? '').trim(), status: undefined }
  return { ok: true, stdout: String(result.stdout ?? '').trim() }
}

/**
 * 解析 canonical Git worktree 与其元数据，不改变任何 Git 状态。
 * 非 worktree 返回 undefined；git 缺失置 gitUnavailableReason 的标志。
 */
// 进程级解析缓存：同一 cwd 的 rev-parse 结果在短时间内不变，而 turn 领取、
// pre-step、命令处理都会重复触发解析。TTL 兼顾正确性（新分支/worktree 切换后
// 元数据仍会刷新）与事件循环友好（冷缓存时一轮同步调用 <100ms）。
const WORKSPACE_CACHE_TTL_MS = 60 * 1000
const workspaceCache = new Map<string, { at: number, info: GitWorkspaceInfo | undefined }>()

/**
 * 单次 rev-parse 同时解析全部元数据：原先每次冷解析要 6 个 spawnSync，
 * 现在合并为 1 个子进程，输出行序与参数顺序一致。
 */
const REV_PARSE_ARGS = [
  'rev-parse',
  '--is-inside-work-tree',
  '--show-toplevel',
  '--git-dir',
  '--git-common-dir',
  '--git-path',
  'index',
  '--git-path',
  'info/exclude',
]

function resolveInfo(requestedDir: string, stdout: string): GitWorkspaceInfo | undefined {
  const lines = stdout.split(/\r?\n/u).filter(line => line.trim() !== '')
  if (lines.length < 6 || lines[0] !== 'true')
    return undefined
  const workspaceRoot = resolve(requestedDir, lines[1]!)
  const resolvedGitDir = resolve(requestedDir, lines[2]!)
  const resolvedCommonDir = resolve(requestedDir, lines[3]!)
  const resolvedIndex = resolve(requestedDir, lines[4]!)
  const resolvedInfoExclude = resolve(requestedDir, lines[5]!)
  if (!existsSync(workspaceRoot) || !existsSync(resolvedGitDir) || !existsSync(resolvedCommonDir))
    return undefined
  return {
    workspaceDir: workspaceRoot,
    requestedDir,
    gitDir: resolvedGitDir,
    commonDir: resolvedCommonDir,
    indexPath: resolvedIndex,
    infoExcludePath: resolvedInfoExclude,
  }
}

function evictOldest(): void {
  if (workspaceCache.size <= 64)
    return
  const oldest = [...workspaceCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
  workspaceCache.delete(oldest[0])
}

/** 后台刷新（stale-while-revalidate 的异步半边）：结果直接落缓存。 */
const refreshInflight = new Map<string, Promise<void>>()

function refreshWorkspaceAsync(requestedDir: string): void {
  if (refreshInflight.has(requestedDir))
    return
  const task = new Promise<GitWorkspaceInfo | undefined>((resolvePromise) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...REV_PARSE_ARGS], {
      cwd: requestedDir,
      env: { ...process.env },
    })
    const chunks: Buffer[] = []
    let settled = false
    const timeout = setTimeout(() => {
      if (settled)
        return
      settled = true
      child.kill('SIGKILL')
      resolvePromise(undefined)
    }, SYNC_GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      if (error.code === 'ENOENT')
        gitExecutableMissing = true
      resolvePromise(undefined)
    })
    child.on('close', (code) => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      resolvePromise(code === 0
        ? resolveInfo(requestedDir, Buffer.concat(chunks).toString('utf8'))
        : undefined)
    })
  }).then((info) => {
    refreshInflight.delete(requestedDir)
    workspaceCache.set(requestedDir, { at: Date.now(), info })
  }).catch(() => {
    refreshInflight.delete(requestedDir)
  })
  refreshInflight.set(requestedDir, task)
}

export function gitWorkspace(workspaceDir: string): GitWorkspaceInfo | undefined {
  const requestedDir = resolve(workspaceDir)
  gitExecutableMissing = false
  const cached = workspaceCache.get(requestedDir)
  if (cached && Date.now() - cached.at < WORKSPACE_CACHE_TTL_MS)
    return cached.info
  if (cached) {
    // stale-while-revalidate：先回缓存值（元数据短暂陈旧可接受——turn 领取
    // 路径对同步返回有硬约束），后台异步刷新，不再每个 turn 反复阻塞事件循环。
    refreshWorkspaceAsync(requestedDir)
    return cached.info
  }
  // 冷未命中：一次同步 rev-parse。
  const result = runGitSync(requestedDir, REV_PARSE_ARGS)
  if (result.error?.code === 'ENOENT') {
    gitExecutableMissing = true
    return undefined
  }
  const info = result.ok ? resolveInfo(requestedDir, result.stdout ?? '') : undefined
  workspaceCache.set(requestedDir, { at: Date.now(), info })
  evictOldest()
  return info
}
