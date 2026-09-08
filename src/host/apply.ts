/**
 * host/apply.ts — 插件装配（turn 生命周期 / 路由 / 命令 / 投影）。
 *
 * 装配顺序与 reasons：
 *   1. 投影先注册——会话列表帧到达前弹窗链路已就绪；
 *   2. HTTP 路由注册在 effect 内，卸载统一释放；
 *   3. pre-step waterfall 是执行 barrier：before 快照（或明确 skip/失败）
 *      settle 之前，任何模型请求与工具调用不得运行；
 *   4. turn/end 落 FIFO 会话链结算 after 快照；
 *   5. 重启清扫挂在 runtime 首建（原子替换 crash 窗口的复活点）。
 */

import type { Ledger } from './service/ledger'
import type { WorkspaceRuntime } from './service/undo'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import process from 'node:process'
import { join, resolve } from 'pathe'
import { TURNREWIND_API_PREFIX } from '../shared/constants'
import { MAX_ENDED_TURNS } from './constants'
import { jsonRoute } from './routes'
import { createDialogProjection } from './service/dialog-projection'
import { collectDoctorReport } from './service/doctor'
import {
  captureSnapshot,
  createSnapshotStore,
  gitAvailable,
  restoreCrashedSwaps,
  snapshotDiff,
} from './service/git-snapshot'
import {
  acknowledgeRecovery,
  claimPendingPlan,
  claimRewindNotices,
  failTurn,
  getLatestSnapshotRef,
  getPendingPlanRow,
  getPendingPlanStatus,
  getTurn,
  hasNeedsRecoveryWorkspace,
  hasSensitiveNotice,
  insertTurn,
  listRecoveryWorkspaces,
  markPendingPlanApplied,
  markPendingPlanCancelled,
  openLedger,
  pruneConsumedNotices,
  queueSensitiveNotice,
  recordSkippedTurn,
  registerWorkspace,
  releasePendingPlanClaim,
  settleInterruptedTurn,
  settleNoopTurn,
  settleTurn,
  skipTurn,
} from './service/ledger'
import { purgeWorkspace } from './service/maintenance'
import { planDrift } from './service/planner'
import { enforceRetention } from './service/retention'
import { findUnignoredSensitiveFiles } from './service/sensitive'
import { applyUndo, buildPlanEntries, executeUndoRestore, parseUndoInput, turnRefsExist, workspaceForAgent, workspaceHasActiveTurn, workspaceIssue, workspaceKeyFor } from './service/undo'
import { acquireWorkspaceLockSync, withWorkspaceLock, WorkspaceLockBusyError } from './service/workspace-lock'

/** 插件名（诊断元数据，与 shared/constants 的 TURNREWIND_PLUGIN_NAME 一致）。 */
export const name = 'dsh-tauri-turnrewind'

/**
 * 需要的宿主服务：
 *   commands             /undo 人类命令
 *   sessionProjections   不可用弹窗的会话投影
 *   webServer            /api/turnrewind/*（卡内 ✓/✗ 与状态轮询）
 */
export const inject = ['commands', 'sessionProjections', 'webServer'] as const

function rootDir(): string {
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
}

export interface HostApplyContext {
  commands: { register: (command: unknown) => () => void }
  sessionProjections: { register: (projection: unknown) => () => void }
  webServer: { register: (route: unknown) => () => void }
  on: (event: string, listener: (...args: any[]) => void) => void
  effect: (factory: () => (() => void) | void, label?: string) => () => void
  logger?: { warn?: (message: string) => void, error?: (message: string) => void }
}

interface ActiveEntry {
  runtime: WorkspaceRuntime
  sessionId: string
  workspaceKey: string
  turnId: string
  beforeRef: string
  baseline: Deferred
  baselineReady: boolean
  startedAt: string
  turn: number
}

interface Deferred {
  promise: Promise<{ ok: boolean, reason?: string }>
  resolve: (value: { ok: boolean, reason?: string }) => void
}

function createDeferred(): Deferred {
  let resolve!: (value: { ok: boolean, reason?: string }) => void
  const promise = new Promise<{ ok: boolean, reason?: string }>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function settleDeferred(deferred: Deferred, value: { ok: boolean, reason?: string }): void {
  deferred.resolve(value)
}

/** turn 前后快照 ref：turnId 的 sha256 前 32 位 + 阶段后缀，稳定且不进用户 refs 命名空间。 */
export function turnSnapshotRef(turnId: string, phase: string): string {
  const digest = createHash('sha256').update(turnId).digest('hex').slice(0, 32)
  return `refs/turnrewind/turn-${digest}-${phase}`
}

function activeKey(sessionId: string, turn: number): string {
  return `${sessionId}:${turn}`
}

export function waitForTurnBaseline(activeTurns: Map<string, ActiveEntry>, sessionId: string, turn: number, signal?: AbortSignal): Promise<{ ok: boolean, reason?: string } | undefined> {
  const entry = activeTurns.get(activeKey(sessionId, turn))
  if (!entry?.baseline)
    return Promise.resolve(undefined)
  if (!signal)
    return entry.baseline.promise
  signal.throwIfAborted()
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      // Propagate the abort reason exactly like the JS version: the pre-step
      // waterfall relies on the rejection to short-circuit the model step.
      // (reject directly - throwing inside an event listener would not
      // settle this promise, leaving the barrier awaiting forever.)
      rejectPromise(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    entry.baseline.promise.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise(value)
    })
  })
}

// ————————————————— 会话 FIFO / 结算 —————————————————

async function settleActiveTurn(ledger: Ledger, active: Map<string, ActiveEntry>, key: string, reason?: string): Promise<void> {
  const current = active.get(key)
  if (!current || current.runtime.disposed)
    return
  try {
    // 跨进程互斥（P1-1）：after 快照 + 账本结算与另一个 Host 进程 /
    // purge 脚本对同一 workspace 的写操作互斥。忙等 5s 后放弃并 failTurn。
    await withWorkspaceLock(current.runtime.store.rootDir, current.runtime.workspaceDir, async () => {
      const afterRef = turnSnapshotRef(current.turnId, 'after')
      await captureSnapshot(current.runtime.store, afterRef, `turnrewind after ${current.turnId}`, current.runtime.parentRef)
      if (current.runtime.disposed)
        return
      const changed = await snapshotDiff(current.runtime.store, current.beforeRef, afterRef)
      if (current.runtime.disposed)
        return
      if (changed.length === 0)
        settleNoopTurn(ledger, current.turnId, afterRef)
      else if (reason)
        settleInterruptedTurn(ledger, current.turnId, afterRef, reason)
      else
        settleTurn(ledger, current.turnId, afterRef)
      current.runtime.parentRef = afterRef
    }, { waitMs: 5000 })
  }
  catch (error) {
    if (!current.runtime.disposed)
      failTurn(ledger, current.turnId, error)
  }
  finally {
    active.delete(key)
  }
}

async function settleSessionTurns(ledger: Ledger, active: Map<string, ActiveEntry>, sessionId: string, exceptKey: string, reason?: string): Promise<void> {
  for (const [key, entry] of [...active.entries()]) {
    if (key === exceptKey || !key.startsWith(`${sessionId}:`) || !entry.baselineReady)
      continue
    await settleActiveTurn(ledger, active, key, reason)
  }
}

// ————————————————— apply 主体 —————————————————

export function apply(ctx: HostApplyContext): void {
  // Git mode uses the project's Git worktree as the snapshot boundary. Its
  // ignore rules replace the old full-directory eligibility scan, while path
  // validation, conflict checks and the private snapshot repository remain.
  const dataRoot = rootDir()
  const ledger = openLedger(dataRoot)
  // P2-11: 日志统一走 ctx.logger（宿主注入的结构化日志），console 仅兜底。
  const log = {
    warn: (message: string): void => {
      if (ctx.logger?.warn)
        ctx.logger.warn(message)
      else
        console.warn(message)
    },
    error: (message: string): void => {
      if (ctx.logger?.error)
        ctx.logger.error(message)
      else
        console.error(message)
    },
  }
  // P1-6：needs-recovery 围栏改为实时查库（hasNeedsRecoveryWorkspace），
  // 运行期落围栏的 workspace 立即被拦截，不再依赖启动时加载的内存快照。
  // One-shot at startup: consumed notices older than a week have no readers
  // left (their dedup window is long gone) and would otherwise accumulate
  // without bound on long-lived installs.
  pruneConsumedNotices(ledger)
  const active = new Map<string, ActiveEntry>()
  const untrackedTurns = new Set<string>()
  const workspaceStores = new Map<string, WorkspaceRuntime>()
  let disposed = false
  const commands = ctx.commands
  // Client-visible projection: lets the web UI raise the unavailable-dialog
  // from the session list it already receives, no conversation API needed.
  ctx.effect(() => ctx.sessionProjections.register(createDialogProjection()), 'turnrewind projection')

  // Per-session FIFO chain: baseline capture, settle and undo bookkeeping for
  // one session never interleave. Git runs asynchronously, so ordering is
  // enforced here instead of by the event loop blocking.
  const sessionChains = new Map<string, Promise<void>>()
  const endedTurns = new Map<string, boolean>()

  function enqueueTurnTask(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = sessionChains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task)
    const settled = next.catch(() => {})
    sessionChains.set(sessionId, settled)
    void settled.then(() => {
      if (sessionChains.get(sessionId) === settled)
        sessionChains.delete(sessionId)
    })
    return next
  }

  function rememberEndedTurn(key: string): boolean {
    const alreadyEnded = endedTurns.has(key)
    endedTurns.set(key, true)
    while (endedTurns.size > MAX_ENDED_TURNS)
      endedTurns.delete(endedTurns.keys().next().value!)
    return alreadyEnded
  }

  function ensureRuntime(agent: { session?: { header?: { cwd?: string } } }): WorkspaceRuntime | undefined {
    const workspaceDir = workspaceForAgent(agent)
    if (!workspaceDir)
      return undefined
    const workspaceKey = workspaceKeyFor(workspaceDir)
    let runtime = workspaceStores.get(workspaceKey)
    if (!runtime) {
      const store = createSnapshotStore(dataRoot, workspaceDir)
      const latest = getLatestSnapshotRef(ledger, workspaceKey)
      registerWorkspace(ledger, workspaceKey, workspaceDir, store.repoDir)
      // First touch since plugin start: resurrect files left mid-swap by a
      // crash in a previous host process (target missing + .bak present)
      // and clear debris (target present + .bak present) - both shapes only
      // exist inside the atomic-restore crash window.
      const resurrected = restoreCrashedSwaps(workspaceDir)
      for (const path of resurrected)
        log.warn(`turnrewind: resurrected ${path} in ${workspaceDir} from a crashed restore swap`)
      // 容量治理（P2-4）：workspace 首次触碰是安全点（无活动 turn、无 undo）。
      // 超出保留条数的 turn 标记过期；仓库超限整仓重建（下次 capture 自愈基线）。
      // 重建/回收是破坏性写，与另一 Host 进程的 capture 互斥：拿一次性跨进程
      // 锁执行；忙（另一进程正在捕获/恢复/清理）则本轮跳过，绝不让治理与
      // 捕获并发写同一仓库——治理是内务，不能阻塞或破坏 turn 追踪。
      try {
        const retentionLock = acquireWorkspaceLockSync(dataRoot, workspaceDir)
        try {
          const retention = enforceRetention(ledger, store)
          if (retention.expiredByCount > 0)
            log.warn(`turnrewind: retention expired ${retention.expiredByCount} turn(s) in ${workspaceDir} (kept the most recent ones)`)
          if (retention.rebuilt)
            log.warn(`turnrewind: snapshot repository for ${workspaceDir} rebuilt by retention (${retention.repoSizeMb.toFixed(1)} MB over the cap; ${retention.expiredByRebuild} turn(s) archived)`)
        }
        finally {
          retentionLock.release()
        }
      }
      catch (error) {
        if (error instanceof WorkspaceLockBusyError)
          log.warn(`turnrewind: workspace busy; snapshot retention skipped this time for ${workspaceDir}`)
        else
          log.error(`turnrewind: snapshot retention failed for ${workspaceDir}: ${String(error)}`)
      }
      runtime = {
        db: ledger,
        store,
        workspaceKey,
        workspaceDir,
        parentRef: latest,
        undoing: false,
        disposed: false,
      }
      workspaceStores.set(workspaceKey, runtime)
    }
    return runtime
  }

  function recordSkipped(turnId: string, sessionId: string, workspaceKey: string, startedAt: string, reason: string, notify = true): void {
    untrackedTurns.add(turnId)
    try {
      if (notify) {
        recordSkippedTurn(ledger, { turnId, sessionId, workspaceKey, startedAt }, reason)
      }
      else {
        skipTurn(ledger, { turnId, sessionId, workspaceKey, startedAt }, reason)
      }
    }
    catch (error) {
      log.error(`turnrewind: failed to record skipped turn ${turnId}: ${String(error)}`)
    }
    log.error(`turnrewind: skipped turn ${turnId}: ${reason}`)
  }

  function reserveTurnBaseline(agent: { session: { id: string, header?: { cwd?: string } } }, turn: number): ActiveEntry | undefined {
    if (disposed)
      return undefined
    const sessionId = agent.session.id
    const key = activeKey(sessionId, turn)
    const existing = active.get(key)
    if (existing)
      return existing
    if (untrackedTurns.has(key) || endedTurns.has(key))
      return undefined
    const existingTurn = getTurn(ledger, key)
    if (existingTurn)
      return undefined
    const startedAt = new Date().toISOString()
    const workspaceDir = workspaceForAgent(agent)
    if (!workspaceDir) {
      // Git-only mode rejects system directories and non-Git workspaces. Keep a
      // durable skipped record so /undo explains why the turn was not tracked.
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) {
        const issue = workspaceIssue(resolve(cwd))
        if (issue)
          recordSkipped(key, sessionId, workspaceKeyFor(resolve(cwd)), startedAt, issue)
      }
      return undefined
    }

    const workspaceKey = workspaceKeyFor(workspaceDir)
    if (hasNeedsRecoveryWorkspace(ledger, workspaceKey)) {
      recordSkipped(key, sessionId, workspaceKey, startedAt, 'TURNREWIND_RECOVERY_REQUIRED: a previous undo or redo was interrupted; inspect the workspace and clear its recovery state before using rewind again')
      return undefined
    }
    const issue = workspaceIssue(workspaceDir)
    if (issue) {
      recordSkipped(key, sessionId, workspaceKey, startedAt, issue)
      return undefined
    }

    const runtime = ensureRuntime(agent)
    if (!runtime)
      return undefined

    if (runtime.undoing) {
      recordSkipped(key, sessionId, workspaceKey, startedAt, 'TURNREWIND_WORKSPACE_BUSY: an undo operation is running')
      return undefined
    }
    for (const entry of active.values()) {
      if (entry.workspaceKey === workspaceKey && entry.sessionId !== sessionId) {
        recordSkipped(key, sessionId, workspaceKey, startedAt, 'TURNREWIND_WORKSPACE_BUSY: another session is using this workspace')
        return undefined
      }
    }

    // `agent/inbox/claimed` is a fire-and-forget notification. Create the
    // deferred synchronously so the awaited pre-step waterfall can always find
    // the reservation after Inbox.claim() returns.
    const beforeRef = turnSnapshotRef(key, 'before')
    const baseline = createDeferred()
    const entry: ActiveEntry = {
      runtime,
      sessionId,
      workspaceKey: runtime.workspaceKey,
      turnId: key,
      beforeRef,
      baseline,
      baselineReady: false,
      startedAt,
      turn,
    }
    active.set(key, entry)

    const baselineTask = async (): Promise<void> => {
      if (disposed || active.get(key) !== entry) {
        settleDeferred(baseline, { ok: false, reason: 'turn was replaced before baseline capture' })
        return
      }
      try {
        const available = await gitAvailable()
        if (disposed || runtime.disposed) {
          settleDeferred(baseline, { ok: false, reason: 'turnrewind plugin disposed during baseline capture' })
          return
        }
        if (!available) {
          active.delete(key)
          const reason = 'TURNREWIND_GIT_UNAVAILABLE: the git executable was not found on PATH; file undo is disabled'
          recordSkipped(key, sessionId, runtime.workspaceKey, startedAt, reason)
          settleDeferred(baseline, { ok: false, reason })
          return
        }
        // A model switch can open B immediately after A is interrupted. Finalize A
        // before capturing B's baseline so B does not absorb A's partial files.
        await settleSessionTurns(ledger, active, sessionId, key, 'interrupted by a newer turn in the same session')
        if (disposed || runtime.disposed) {
          settleDeferred(baseline, { ok: false, reason: 'turnrewind plugin disposed during baseline capture' })
          return
        }
        // 跨进程互斥（P1-1）：before 快照 + turn 入账与另一个进程对同一
        // workspace 的写操作互斥；忙等 5s 后按显式 skip 释放 barrier。
        await withWorkspaceLock(dataRoot, runtime.workspaceDir, async () => {
          if (disposed || runtime.disposed)
            return
          await captureSnapshot(runtime.store, beforeRef, `turnrewind before ${key}`, runtime.parentRef)
          if (disposed || runtime.disposed)
            return
          insertTurn(ledger, {
            turnId: key,
            sessionId,
            workspaceKey: runtime.workspaceKey,
            startedAt,
            beforeRef,
          })
          entry.baselineReady = true
        }, { waitMs: 5000 })
        if (disposed || runtime.disposed) {
          settleDeferred(baseline, { ok: false, reason: 'turnrewind plugin disposed during baseline capture' })
          return
        }
        // 敏感文件一次性提醒（P2-5 隐私面）：不持锁（扫描 + check-ignore 是
        // 纯读），每会话+工作区只扫一次——已有提醒的会话直接跳过扫描。
        if (!disposed && !runtime.disposed && !hasSensitiveNotice(ledger, sessionId, runtime.workspaceKey)) {
          try {
            const sensitive = await findUnignoredSensitiveFiles(runtime.workspaceDir)
            if (sensitive.length > 0)
              queueSensitiveNotice(ledger, sessionId, runtime.workspaceKey, sensitive)
          }
          catch (scanError) {
            log.warn(`turnrewind: sensitive-file scan failed (ignored): ${String(scanError)}`)
          }
        }
        settleDeferred(baseline, { ok: true })
      }
      catch (error) {
        active.delete(key)
        const reason = error instanceof WorkspaceLockBusyError
          ? error.message
          : `TURNREWIND_CAPTURE_FAILED: ${String(error)}`
        // Transient capture failure (disk full, permissions): record the skip
        // before releasing the barrier, so the turn is explicitly untracked.
        if (!disposed && !runtime.disposed)
          recordSkipped(key, sessionId, runtime.workspaceKey, startedAt, reason, false)
        settleDeferred(baseline, { ok: false, reason })
        if (!disposed && !runtime.disposed)
          log.error(`turnrewind: failed to start turn ${key}: ${String(error)}`)
      }
    }
    void enqueueTurnTask(sessionId, baselineTask).catch((error: unknown) => {
      // Keep the barrier finite even if future changes add an exception outside
      // baselineTask's guarded body.
      if (active.get(key) === entry)
        active.delete(key)
      const reason = `TURNREWIND_CAPTURE_FAILED: ${String(error)}`
      if (!disposed && !runtime.disposed)
        recordSkipped(key, sessionId, runtime.workspaceKey, startedAt, reason, false)
      settleDeferred(baseline, { ok: false, reason })
      if (!disposed && !runtime.disposed)
        log.error(`turnrewind: baseline queue failed for ${key}: ${String(error)}`)
    })
    return entry
  }

  // Same-origin HTTP routes powering the ✓/✗ buttons on the undo card: the
  // harness page itself is served from this host, so these need no extra
  // auth wiring (and mutations are loopback-only on top).
  // P1-3: planId 必须是 UUID 形态、session 长度受限且无控制字符——
  // 防止任意字符串进入日志与 SQLite 语义。
  const PLAN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const validPlanId = (value: string): boolean => PLAN_ID_RE.test(value)
  const validSessionId = (value: string): boolean =>
    value.length >= 1 && value.length <= 200 && [...value].every(ch => ch.charCodeAt(0) > 31)
  ctx.effect(() => {
    function confirmRoute(body: Record<string, unknown>): Promise<[number, unknown]> | [number, unknown] {
      const planId = String(body.planId ?? '')
      const sessionId = String(body.sessionId ?? '')
      if (planId === '' || sessionId === '')
        return [400, { error: 'planId and sessionId are required' }]
      if (!validPlanId(planId) || !validSessionId(sessionId))
        return [400, { error: 'planId or sessionId is malformed' }]
      const previewRow = getPendingPlanRow(ledger, planId)
      if (previewRow === undefined)
        return [404, { error: 'plan not found — run /undo again' }]
      if (previewRow.session_id !== sessionId)
        return [403, { error: 'the plan belongs to another session' }]
      // 过期 plan 已转 expired 留档：明确告知过期（可查看，不可执行）。
      if (previewRow.status === 'expired')
        return [409, { error: 'this plan has expired — run /undo again to preview a fresh plan' }]
      if (previewRow.status !== 'pending')
        return [409, { error: 'this plan was already applied or cancelled — run /undo again' }]
      const planRuntime = workspaceStores.get(previewRow.workspace_key)
      if (planRuntime === undefined)
        return [409, { error: 'the host restarted since this preview; run /undo again' }]
      // P1-6：实时围栏——预览后落 needs-recovery 的 workspace 立即拒绝执行。
      if (hasNeedsRecoveryWorkspace(ledger, previewRow.workspace_key))
        return [409, { error: 'TURNREWIND_RECOVERY_REQUIRED: the workspace needs recovery (a previous operation was interrupted) — open the recovery panel to resolve' }]
      if (planRuntime.undoing || workspaceHasActiveTurn(active, previewRow.workspace_key))
        return [409, { error: 'the workspace is busy — wait for the current turn to finish' }]
      const claim = claimPendingPlan(ledger, planId, sessionId)
      if (!claim.ok)
        return [claim.code, { error: claim.error }]
      const row = claim.row
      planRuntime.undoing = true
      let committed = false
      return (async (): Promise<[number, unknown]> => {
        try {
          const target = getTurn(ledger, row.turn_id)
          if (target === undefined || target.reversible !== 1 || !target.before_ref || !target.after_ref || !await turnRefsExist(planRuntime.store, target))
            return [409, { error: 'the planned turn\'s snapshot data no longer exists — run /undo again' }]
          const paths = await snapshotDiff(planRuntime.store, target.before_ref, target.after_ref)
          // 计划漂移校验（P1-2）：与命令路径同一规则——确认时的快照 ref 与
          // 重算 diff 必须与预览一致，否则拒绝并要求重新预览。
          const drift = planDrift(row, target, paths)
          if (drift)
            return [409, { error: `${drift} — run /undo again to refresh the plan` }]
          if (paths.length === 0) {
            markPendingPlanApplied(ledger, planId, sessionId, 'No file changes were recorded for this turn.')
            committed = true
            return [200, { ok: true, message: 'No file changes were recorded for this turn.' }]
          }
          const entries = await buildPlanEntries(planRuntime, planRuntime.workspaceDir, target, paths)
          const conflicts = entries.filter(entry => entry.conflict)
          if (conflicts.length > 0)
            return [409, { error: `the workspace changed since the preview (${conflicts.length} conflicted file(s)) — run /undo again to refresh the plan` }]
          let message: string
          try {
            message = await executeUndoRestore(planRuntime, {
              sessionId,
              workspaceKey: row.workspace_key,
              target,
              paths,
              entries,
              skipConflicts: false,
            })
          }
          catch (error) {
            // 另一个进程正持有该 workspace 的锁（P1-1）：计划仍未消费，
            // 以 409 告知客户端稍后重试。
            if (error instanceof WorkspaceLockBusyError)
              return [409, { error: `${(error as Error).message} — retry shortly` }]
            throw error
          }
          markPendingPlanApplied(ledger, planId, sessionId, message)
          committed = true
          return [200, { ok: true, message }]
        }
        finally {
          if (!committed)
            releasePendingPlanClaim(ledger, planId)
          planRuntime.undoing = false
        }
      })()
    }

    function cancelRoute(body: Record<string, unknown>): [number, unknown] {
      const planId = String(body.planId ?? '')
      const sessionId = String(body.sessionId ?? '')
      if (planId === '' || sessionId === '')
        return [400, { error: 'planId and sessionId are required' }]
      if (!validPlanId(planId) || !validSessionId(sessionId))
        return [400, { error: 'planId or sessionId is malformed' }]
      // 非 pending 行返回精确错误而不是 200 假成功：假成功会让客户端先塌缩成
      // 「已取消」，刷新后又被轮询纠正成别的状态——状态必须一次说清。
      const row = getPendingPlanRow(ledger, planId)
      if (row === undefined)
        return [404, { error: 'plan not found — run /undo again' }]
      if (row.session_id !== sessionId)
        return [403, { error: 'the plan belongs to another session' }]
      if (row.status === 'cancelled')
        return [200, { ok: true, message: 'Pending undo cancelled.' }]
      if (row.status === 'expired')
        return [409, { error: 'this plan has expired — run /undo again to preview a fresh plan' }]
      if (row.status === 'applied')
        return [409, { error: 'this plan was already applied' }]
      if (row.status === 'applying')
        return [409, { error: 'this plan is being applied — wait for it to finish' }]
      const removed = markPendingPlanCancelled(ledger, planId, sessionId)
      if (!removed)
        return [409, { error: 'this plan was already applied or cancelled — run /undo again' }]
      return [200, { ok: true, message: 'Pending undo cancelled.' }]
    }

    // ——— 恢复面板路由：被围 workspace 的查询与解锁（acknowledge | purge） ———

    function recoveryRoute(): [number, unknown] {
      return [200, { workspaces: listRecoveryWorkspaces(ledger) }]
    }

    function recoveryResolveRoute(body: Record<string, unknown>): [number, unknown] {
      const workspaceKey = String(body.workspaceKey ?? '')
      const mode = String(body.mode ?? '')
      if ((mode !== 'acknowledge' && mode !== 'purge') || workspaceKey === '' || workspaceKey.length > 500)
        return [400, { error: 'workspaceKey and mode (acknowledge|purge) are required' }]
      const fenced = listRecoveryWorkspaces(ledger).find(workspace => workspace.workspace_key === workspaceKey)
      if (fenced === undefined)
        return [404, { error: 'this workspace is not under recovery' }]
      if (mode === 'acknowledge') {
        const acknowledged = acknowledgeRecovery(ledger, workspaceKey)
        return [200, { ok: true, acknowledged }]
      }
      try {
        // purgeWorkspace 自带跨进程锁，workspace 被占用时拒绝。传 workspace_key
        // 而非客户端输入的路径：它正是 purge 哈希与账本行使用的规范输入。
        const summary = purgeWorkspace(dataRoot, workspaceKey)
        return [200, { ok: true, purged: summary }]
      }
      catch (error) {
        if (error instanceof WorkspaceLockBusyError)
          return [409, { error: `${(error as Error).message} — stop the host process using this workspace first` }]
        throw error
      }
    }

    function statusRoute(_body: Record<string, unknown>, req: { url?: string }): [number, unknown] {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const planId = String(url.searchParams.get('planId') ?? '')
      const sessionId = String(url.searchParams.get('sessionId') ?? '')
      if (planId === '' || sessionId === '')
        return [400, { error: 'planId and sessionId are required' }]
      if (!validPlanId(planId) || !validSessionId(sessionId))
        return [400, { error: 'planId or sessionId is malformed' }]
      const status = getPendingPlanStatus(ledger, planId, sessionId)
      if (status === undefined)
        return [404, { error: 'plan expired, unavailable, or owned by another session — run /undo again' }]
      return [200, status]
    }

    const routes = [
      jsonRoute(`${TURNREWIND_API_PREFIX}/confirm`, confirmRoute, { mutate: true }),
      jsonRoute(`${TURNREWIND_API_PREFIX}/cancel`, cancelRoute, { mutate: true }),
      jsonRoute(`${TURNREWIND_API_PREFIX}/status`, statusRoute, { methods: ['GET'] }),
      jsonRoute(`${TURNREWIND_API_PREFIX}/recovery`, recoveryRoute, { methods: ['GET'] }),
      jsonRoute(`${TURNREWIND_API_PREFIX}/recovery/resolve`, recoveryResolveRoute, { mutate: true }),
    ]
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => disposers.map(dispose => dispose())
  }, 'turnrewind routes')

  ctx.on('agent/pre-step', async ({ agent, turn, signal }: { agent: { session: { id: string, header?: { cwd?: string } } }, turn: number, signal: AbortSignal }, next: () => Promise<{ kind: string, messages?: unknown[] }>) => {
    // `agent/inbox/claimed` is an emit notification: Cordis deliberately does
    // not await listener promises. It synchronously reserves the active entry
    // and starts the baseline task, while this awaited waterfall is the actual
    // execution barrier. No downstream pre-step listener, model request, or
    // tool call may run until the before snapshot (or an explicit skip/failure)
    // has settled. The fallback creates the reservation here as well, so a
    // missed notification cannot silently allow an unprotected turn through.
    const key = activeKey(agent.session.id, turn)
    const entry = active.get(key) ?? (untrackedTurns.has(key) || endedTurns.has(key) ? undefined : reserveTurnBaseline(agent, turn))
    await waitForTurnBaseline(active, agent.session.id, turn, signal)
    signal.throwIfAborted()
    if (disposed)
      return { kind: 'reject' }
    if (!entry && workspaceForAgent(agent) && !untrackedTurns.has(key) && !endedTurns.has(key))
      log.error(`turnrewind: no baseline reservation for ${key}; turn is explicitly untracked`)
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || disposed)
      return decision
    // Claiming must work even when workspaceForAgent refuses the cwd (home
    // dir): that is exactly the session kind the unsupported heads-up is
    // queued for. Fall back to the raw cwd as the workspace key.
    const cwd = agent?.session?.header?.cwd
    const workspaceDir = workspaceForAgent(agent)
      ?? (typeof cwd === 'string' && cwd.length > 0 ? resolve(cwd) : undefined)
    if (!workspaceDir)
      return decision
    const notices = claimRewindNotices(ledger, agent.session.id, workspaceKeyFor(workspaceDir))
    if (notices.length === 0)
      return decision
    const { createNoticeMessage } = await import('./service/undo')
    return {
      ...decision,
      messages: [...(decision.messages ?? []), ...notices.map(notice => createNoticeMessage(notice))],
    }
  })

  ctx.on('agent/inbox/claimed', (payload: { agent: { session: { id: string, header?: { cwd?: string } } }, turn: number }) => {
    if (!disposed)
      reserveTurnBaseline(payload.agent, payload.turn)
  })

  ctx.on('session/event', (session: { id: string }, event: { type?: string, data?: { turn?: number, reason?: { kind?: string } } }) => {
    if (disposed || event.type !== 'turn/end' || typeof event.data?.turn !== 'number')
      return
    const key = activeKey(session.id, event.data.turn)
    rememberEndedTurn(key)
    if (untrackedTurns.delete(key))
      return
    if (!active.has(key))
      return
    const reason = event.data.reason?.kind
    const interrupted = reason === 'aborted' || reason === 'error' || reason === 'cancelled'
    void enqueueTurnTask(session.id, () => settleActiveTurn(ledger, active, key, interrupted ? `turn ended with ${reason}` : undefined))
  })
  ctx.on('agent/turn-stopping', () => {
    // A normal turn reaches the durable turn/end event immediately after this
    // listener. Wait for that authoritative boundary so interrupted writes are
    // included in the after snapshot.
  })
  ctx.on('agent/error', (payload: { agent: { session: { id: string } }, turn: number, error: unknown }) => {
    // Keep the active record until turn/end or the idle fallback. In particular,
    // model switching can emit an error before the final partial writes finish.
    log.error(`turnrewind: observed agent error for ${activeKey(payload.agent.session.id, payload.turn)}: ${String(payload.error)}`)
  })
  ctx.on('agent/status', ({ agent, status }: { agent: { session: { id: string } }, status: string }) => {
    if (disposed || status !== 'idle')
      return
    const sessionId = agent.session.id
    for (const key of [...active.keys()]) {
      if (key.startsWith(`${sessionId}:`))
        void enqueueTurnTask(sessionId, () => settleActiveTurn(ledger, active, key, 'agent became idle after interruption'))
    }
  })
  ctx.effect(() => () => {
    // A plugin stop/HMR can happen while pre-step is awaiting a baseline. Mark
    // every runtime first, release waiters, then wait for FIFO tasks before
    // closing SQLite.
    disposed = true
    for (const runtime of workspaceStores.values())
      runtime.disposed = true
    for (const entry of active.values())
      settleDeferred(entry.baseline, { ok: false, reason: 'turnrewind plugin disposed during baseline capture' })
    active.clear()
    untrackedTurns.clear()
    endedTurns.clear()
    workspaceStores.clear()
    return (async () => {
      await Promise.allSettled([...sessionChains.values()])
      ledger.close()
    })()
  }, 'turnrewind runtime')
  ctx.effect(() => commands.register({
    name: 'undo',
    description: 'Plan or undo file changes made by the latest Agent turn',
    input: { hint: '[turn-id] [--dry-run|--preview] [--skip-conflicts|--force] | --doctor' },
    handler: (invocation: { rawInput: string, agent: { session: { id: string, header?: { cwd?: string } } } }) => {
      const parsed = parseUndoInput(invocation.rawInput)
      // --doctor 在工作区资格判定之前短路：诊断恰恰要在「undo 不可用」时给出
      // 原因，不能被资格检查挡掉。
      if (!('error' in parsed) && parsed.doctor)
        return collectDoctorReport(ledger, dataRoot, invocation.agent).then(text => ({ kind: 'success' as const, text }))
      const workspaceDir = workspaceForAgent(invocation.agent)
      if (!workspaceDir) {
        // The hard guard refused the cwd; report the actual reason when there is one.
        const cwd = invocation.agent?.session?.header?.cwd
        const issue = typeof cwd === 'string' && cwd.length > 0 ? workspaceIssue(resolve(cwd)) : undefined
        if (issue)
          return { kind: 'error', text: `Undo is unavailable for this workspace. ${issue}` }
        return { kind: 'error', text: 'Undo is unavailable because this session has no workspace.' }
      }
      const workspaceIdentity = workspaceKeyFor(workspaceDir)
      if (hasNeedsRecoveryWorkspace(ledger, workspaceIdentity))
        return { kind: 'error', text: 'TURNREWIND_RECOVERY_REQUIRED: a previous undo or redo was interrupted. Open the recovery panel (from the "Turn rewind unavailable" notice) to inspect the workspace, keep the history acknowledged, or clear its rewind data.' }
      const issue = workspaceIssue(workspaceDir)
      if (issue)
        return { kind: 'error', text: `Undo is unavailable for this workspace. ${issue}` }
      const runtime = ensureRuntime(invocation.agent)
      if (!runtime)
        return { kind: 'error', text: 'Undo is unavailable because the Git workspace could not be initialized.' }
      return applyUndo(runtime, active, { rawInput: invocation.rawInput, agent: invocation.agent }, {
        workspaceForAgent,
        workspaceIssue,
        workspaceKeyFor,
      })
    },
  }), 'turnrewind command')
}
