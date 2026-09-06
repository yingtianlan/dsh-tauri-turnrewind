/**
 * host/service/retention.ts — 快照容量治理（P2-4）。
 *
 * 约束：快照提交是链式的（每次 capture 以最新 ref 为 parent），删除中间 ref
 * 后 `git gc` 也无法回收（新提交仍可达旧对象）。因此空间治理的两级策略：
 *
 * 1. 保留条数（TURNREWIND_RETAIN_TURNS，默认 50）：每个 workspace 只保留
 *    最近 N 个可撤销 turn，更老的标记 reversible=0（账本行保留为审计），
 *    不再作为 /undo 目标。零数据移动、零风险。
 * 2. 仓库重建（TURNREWIND_MAX_SNAPSHOT_MB，默认 1024）：快照仓库超限时
 *    整仓删除——下一次 capture 走既有的「parent 丢失 → 重建基线」自愈路径，
 *    空间全量回收；该 workspace 全部可撤销 turn 如实标记 expired，账本与
 *    操作审计保留。
 *
 * 触发点：Host 启动后每个 workspace 首次触碰（ensureRuntime）——此时该
 * workspace 无活动 turn、无进行中的 undo，是唯一无锁需要的静默安全点。
 * 低磁盘提前失败（statfs）属平台能力，留待 sandbox bridge 一并接入。
 */

import type { SnapshotStore } from '../types'
import type { Ledger } from './ledger'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import process from 'node:process'
import { join } from 'pathe'
import { SYNC_GIT_TIMEOUT_MS } from '../constants'
import { workspaceKey } from './git-snapshot'

/** 每个 workspace 保留的最近可撤销 turn 数。 */
export const DEFAULT_RETAIN_TURNS = 50

/** 快照仓库容量上限（MB），超过即整仓重建。 */
export const DEFAULT_MAX_SNAPSHOT_MB = 1024

function readPositiveEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '')
    return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export interface RetentionOptions {
  retainTurns?: number
  maxSnapshotMb?: number
}

export interface RetentionResult {
  /** 因超出保留条数被标记过期的 turn 数。 */
  expiredByCount: number
  /** 因仓库超限被重建（true 时该 workspace 全部可撤销 turn 同时过期）。 */
  rebuilt: boolean
  /** 重建/过期时一并标记的 turn 数（含 expiredByCount 之外的部分）。 */
  expiredByRebuild: number
  /** 快照仓库当前占用（MB，重建前测量）。 */
  repoSizeMb: number
}

function directorySizeMb(dir: string): number {
  let total = 0
  const visit = (path: string): void => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) {
        visit(full)
      }
      else if (entry.isFile()) {
        try {
          total += Number(statSync(full).size)
        }
        catch {
          // 并发清理/AV 句柄：丢一个文件的统计不影响量级判断。
        }
      }
    }
  }
  visit(dir)
  return total / (1024 * 1024)
}

/**
 * 回收私有仓库中不可达的 loose object。主要来源是 diffAgainstDisk 把冲突文件
 * 的当前磁盘内容 `hash-object -w` 进仓库：这些对象没有任何 ref 可达，反复
 * 预览/冲突 diff 会持续积累，是提前触发整仓重建的主因。prune 只删除不可达
 * 对象（refs/turnrewind/* 链上的对象不受影响），放在容量测量之前，让上限
 * 判断基于治理后的真实占用。同步执行：与 git-workspace 的 rev-parse 同级，
 * 仅在 workspace 首次触碰（每进程每仓库一次）发生。
 */
function pruneRepoLooseObjects(repoDir: string): void {
  if (!existsSync(join(repoDir, 'HEAD')))
    return
  try {
    spawnSync('git', ['--git-dir', repoDir, 'prune', '--expire=now'], {
      timeout: SYNC_GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
  }
  catch {
    // 容量治理尽力而为：prune 失败（git 缺失/被击杀）不影响过期与重建逻辑。
  }
}

/**
 * 对一个 workspace 执行容量治理。在无活动 turn / 无 undo 的安全点调用
 * （当前唯一调用点：ensureRuntime 的 workspace 首次触碰，调用方持跨进程
 * workspace 锁）。
 */
export function enforceRetention(db: Ledger, store: SnapshotStore, options: RetentionOptions = {}): RetentionResult {
  const retainTurns = options.retainTurns ?? readPositiveEnv('TURNREWIND_RETAIN_TURNS') ?? DEFAULT_RETAIN_TURNS
  const maxSnapshotMb = options.maxSnapshotMb ?? readPositiveEnv('TURNREWIND_MAX_SNAPSHOT_MB') ?? DEFAULT_MAX_SNAPSHOT_MB
  const workspaceIdentity = workspaceKey(store.workspaceDir)
  const result: RetentionResult = { expiredByCount: 0, rebuilt: false, expiredByRebuild: 0, repoSizeMb: 0 }

  // 1) 保留条数：最近 N 个之外的可撤销 turn 标记过期（账本行保留审计）。
  const reversible = db.prepare(`
    SELECT turn_id FROM turns
    WHERE workspace_key = ? AND reversible = 1 AND status IN ('settled', 'interrupted')
    ORDER BY started_at DESC
  `).all(workspaceIdentity) as { turn_id: string }[]
  const excess = reversible.slice(retainTurns)
  const expire = db.prepare(`
    UPDATE turns SET reversible = 0,
      error = 'retention: beyond the most recent kept reversible turns'
    WHERE turn_id = ? AND reversible = 1
  `)
  for (const row of excess)
    result.expiredByCount += Number(expire.run(row.turn_id).changes)

  // 2) 容量上限：先回收不可达 loose object，再测量治理后的真实占用；
  //    超限即整仓重建——旧 turn 的 refs 随仓消失，全部如实标记，
  //    下一次 capture 经既有自愈路径建立新基线。
  pruneRepoLooseObjects(store.repoDir)
  result.repoSizeMb = directorySizeMb(store.repoDir)
  if (result.repoSizeMb > maxSnapshotMb) {
    // 两阶段重建：先把 live 仓库整体改名进隔离目录，再删隔离目录。rename
    // 是原子发布点，之后任何一步死亡都自洽——live 路径已空，下次 capture
    // 走既有自愈路径重建基线，账本过期如实；直删在半途死亡会留下一个半删
    // 的 live 目录。固定名隔离目录由本轮先清：同 workspace 的治理已被
    // workspace 锁串行化，残留只可能来自上一轮崩溃。
    const quarantine = `${store.repoDir}.retention-quarantine`
    rmSync(quarantine, { recursive: true, force: true })
    db.prepare(`
      UPDATE turns SET reversible = 0,
        error = 'retention: snapshot repository rebuilt (size cap)'
      WHERE workspace_key = ? AND reversible = 1 AND status IN ('settled', 'interrupted')
    `).run(workspaceIdentity)
    renameSync(store.repoDir, quarantine)
    try {
      rmSync(quarantine, { recursive: true, force: true })
    }
    catch {
      // 尽力而为：隔离目录残留不回滚账本（过期已是事实），下一轮治理重试。
    }
    result.rebuilt = true
    result.expiredByRebuild = reversible.length
  }
  return result
}
