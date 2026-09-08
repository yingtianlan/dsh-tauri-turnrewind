/**
 * host/service/undo.ts — undo 执行核心：计划构建/格式化、两阶段 pending plan、
 * 原子恢复（含单文件失败收集）、redo（冻结中）、回滚与 notice 注入消息。
 *
 * 执行不变式：执行前先拍 operation 快照（beforeRef）；--skip-conflicts 的回滚
 * 只碰实际尝试过的路径（用户明确保留的冲突文件绝不覆盖）；单文件恢复失败
 * 计入「未恢复」清单而不炸整体；操作异常时从 beforeRef 回滚，回滚也失败则
 * 落 needs-recovery 由启动围栏拦截。
 */

import type { PlanEntry, SnapshotStore, UndoInput } from '../types'
import type { Ledger, PendingPlanRow, TurnRow } from './ledger'
import { randomUUID } from 'node:crypto'
import { resolve } from 'pathe'
import { MAX_FILE_BYTES } from '../constants'
import {
  captureSnapshot,
  classifyPathChange,
  currentState,
  gitRef,
  probeWorkspace,
  restorePath,
  snapshotDiff,
  snapshotFileDiff,
  stateAt,
  workspaceKey,
} from './git-snapshot'
import { isSystemSensitiveWorkspace } from './guard'

/**
 * applyUndo — /undo 命令入口（两阶段流：预览卡 → --confirm 执行）。
 *
 * 依赖 workspaceForAgent/workspaceIssue/workspaceKeyFor（宿主装配层的判定），
 * 经 WorkspaceEnv 注入保持本文件可独立单测。
 */

import {
  claimPendingPlan,
  completeRedoTransaction,
  completeUndoTransaction,
  createOperation,
  createPendingPlan,
  getLatestAppliedUndo,
  getLatestTurnSummary,
  getTurn,
  listReversibleTurns,
  markPendingPlanApplied,
  markPendingPlanCancelled,
  markTurnSnapshotMissing,
  releasePendingPlanClaim,
  settleOperation,
} from './ledger'

import { classifyUndo, planDrift } from './planner'
import { acquireWorkspaceLock } from './workspace-lock'

// ————————————————— redo（与 undo 同等的生产加固：applying operation / 失败明细 / needs-recovery） —————————————————

async function applyRedo(runtime: WorkspaceRuntime, invocation: UndoInvocation, workspaceDir: string, workspaceKey: string): Promise<UndoOutcome> {
  const op = getLatestAppliedUndo(runtime.db, invocation.agent.session.id, workspaceKey)
  if (!op)
    return { kind: 'error', text: 'No previously applied undo is available to redo.' }
  const turn = getTurn(runtime.db, op.target_turn_id)
  if (!turn || !turn.before_ref || !turn.after_ref)
    return { kind: 'error', text: 'The undone turn no longer has a recoverable snapshot.' }
  if (!await turnRefsExist(runtime.store, turn))
    return { kind: 'error', text: 'The snapshot data for the undone turn no longer exists (the snapshot repository was previously wiped).' }
  const paths = await snapshotDiff(runtime.store, turn.before_ref, turn.after_ref)
  if (paths.length === 0)
    return { kind: 'success', text: 'No file changes were recorded for this turn.' }

  const conflicts: string[] = []
  for (const path of paths) {
    const expected = await stateAt(runtime.store, turn.before_ref, path)
    const actual = await currentState(workspaceDir, path)
    if (classifyUndo(actual, expected) === 'conflict')
      conflicts.push(path)
  }
  if (conflicts.length > 0) {
    const lines: string[] = []
    lines.push(`Redo is blocked: ${conflicts.length} conflicted file(s) were edited after the undo.`)
    lines.push('')
    lines.push('Conflicts (undone state → current disk; redo would overwrite these changes):')
    for (const path of conflicts) {
      const diff = await safeDiffAgainstDisk(runtime.store, turn.before_ref, path)
      lines.push(`--- ${path}`)
      lines.push(diff ? indent(diff, '  ') : '  (no textual diff)')
    }
    return { kind: 'error', text: lines.join('\n') }
  }

  runtime.undoing = true
  try {
    // 与 undo 相同的跨进程互斥（P1-1）；redo 虽被入口冻结，加固路径保持一致。
    const lock = await acquireWorkspaceLock(runtime.store.rootDir, runtime.workspaceDir, { waitMs: 10000 })
    try {
      const operationId = randomUUID()
      const beforeRef = `refs/turnrewind/redo-${operationId}`
      await captureSnapshot(runtime.store, beforeRef, `turnrewind redo ${turn.turn_id}`, runtime.parentRef)
      // redo 与 undo 对等：先登记 applying operation，崩溃/账本失败时由
      // needs-recovery 围栏接管，不再留下无围栏的部分 redo（P0-4）。
      createOperation(runtime.db, {
        operationId,
        kind: 'redo',
        targetTurnId: turn.turn_id,
        requestedAt: new Date().toISOString(),
        beforeRef,
      })
      const restoredPaths: string[] = []
      const failedPaths: { path: string, reason: string }[] = []
      for (const path of paths) {
        try {
          await restorePath(runtime.store, turn.after_ref, path)
          restoredPaths.push(path)
        }
        catch (error) {
          // 与 undo 相同的单路径策略：一个文件失败不炸整体，失败明细持久化。
          failedPaths.push({ path, reason: String((error as Error).message ?? error) })
        }
      }
      completeRedoTransaction(runtime.db, {
        noticeId: randomUUID(),
        sessionId: invocation.agent.session.id,
        workspaceKey,
        targetTurnId: turn.turn_id,
        redoneOperationId: op.operation_id,
        operationId,
        restoredPaths,
        notRestored: failedPaths,
        createdAt: new Date().toISOString(),
      })
      runtime.parentRef = beforeRef
      let text = `re-applied ${restoredPaths.length} file(s). The next model request will receive a rewind notice.`
      if (failedPaths.length > 0)
        text += ` Not restored (${failedPaths.length} file(s)): ${failedPaths.map(failure => `${failure.path} (${failure.reason.includes('TURNREWIND_FILE_TOO_LARGE') ? 'over the size limit' : failure.reason})`).join('; ')}.`
      return { kind: 'success', text }
    }
    finally {
      lock.release()
    }
  }
  catch (error) {
    // completeRedoTransaction 已把本次 redo operation 落 needs-recovery，
    // 启动围栏会拦截该 workspace；这里只负责把原因带给用户。
    return { kind: 'error', text: String((error as Error)?.message ?? error) }
  }
  finally {
    runtime.undoing = false
  }
}

// ————————————————— workspace 判定（与 host/apply 共用的唯一实现） —————————————————

export function workspaceForSession(session: { header?: { cwd?: string } } | undefined): string | undefined {
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0)
    return undefined
  const resolved = resolve(cwd)
  if (isSystemSensitiveWorkspace(resolved))
    return undefined
  const probe = probeWorkspace(resolved)
  return probe.ok ? probe.workspaceDir : undefined
}

export function workspaceForAgent(agent: { session?: { header?: { cwd?: string } } } | undefined): string | undefined {
  return workspaceForSession(agent?.session)
}

export function workspaceKeyFor(path: string): string {
  return workspaceKey(path)
}

export function workspaceIssue(workspaceDir: string): string | undefined {
  if (isSystemSensitiveWorkspace(workspaceDir))
    return `TURNREWIND_WORKSPACE_UNSUPPORTED: ${workspaceDir} is a system directory`
  const probe = probeWorkspace(workspaceDir)
  return probe.ok ? undefined : probe.reason
}

export interface WorkspaceRuntime {
  db: Ledger
  store: SnapshotStore
  workspaceKey: string
  workspaceDir: string
  parentRef: string | undefined
  undoing: boolean
  disposed: boolean
}

export interface UndoInvocation {
  rawInput: string
  agent: { session: { id: string, header?: { cwd?: string } } }
}

export interface UndoOutcome {
  kind: 'success' | 'error'
  text: string
}

/** 解析 /undo 的输入行（turn id / 预览与冲突策略 / 两阶段 confirm/cancel / 诊断）。 */
export function parseUndoInput(rawInput: string): UndoInput | { error: string } {
  const parts = rawInput.trim().split(/\s+/u).filter(Boolean)
  let turnId: string | undefined
  let dryRun = false
  let preview = false
  let skipConflicts = false
  let force = false
  let redo = false
  let confirm = false
  let cancel = false
  let doctor = false
  for (const part of parts) {
    if (part === '--dry-run')
      dryRun = true
    else if (part === '--preview')
      preview = true
    else if (part === '--skip-conflicts')
      skipConflicts = true
    else if (part === '--force')
      force = true
    else if (part === '--redo')
      redo = true
    else if (part === '--confirm')
      confirm = true
    else if (part === '--cancel')
      cancel = true
    else if (part === '--doctor')
      doctor = true
    else if (part === '--subtree')
      return { error: 'Recursive subtree undo is not available in the MVP.' }
    else if (turnId === undefined)
      turnId = part
    else
      return { error: 'Usage: /undo [--preview] | /undo --confirm <plan-id> | /undo --cancel <plan-id> | /undo <turn-id> --force' }
  }
  if (skipConflicts && force)
    return { error: '--skip-conflicts and --force are mutually exclusive.' }
  if (redo && (turnId !== undefined || dryRun || preview || skipConflicts || force || confirm || cancel))
    return { error: '--redo cannot be combined with a turn id or other options.' }
  if (doctor && (turnId !== undefined || dryRun || preview || skipConflicts || force || redo || confirm || cancel))
    return { error: 'Usage: /undo --doctor (cannot be combined with other options).' }
  if ((confirm || cancel) && (dryRun || preview || skipConflicts || force))
    return { error: '--confirm/--cancel cannot be combined with preview or conflict-override flags.' }
  if (confirm && cancel)
    return { error: '--confirm and --cancel are mutually exclusive.' }
  if ((confirm || cancel) && turnId === undefined)
    return { error: confirm ? 'Usage: /undo --confirm <plan-id>' : 'Usage: /undo --cancel <plan-id>' }
  return { turnId, dryRun, preview, skipConflicts, force, redo, confirm, cancel, doctor }
}

export function assertSessionOwner(target: TurnRow, agent: { session: { id: string } }): UndoOutcome | undefined {
  if (target.session_id !== agent.session.id)
    return { kind: 'error', text: 'The selected turn belongs to another session.' }
  return undefined
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map(line => prefix + line).join('\n')
}

async function safeDiffAgainstDisk(store: SnapshotStore, ref: string, path: string): Promise<string> {
  try {
    const { diffAgainstDisk } = await import('./git-snapshot')
    return await diffAgainstDisk(store, ref, path)
  }
  catch {
    return '(unable to inspect the on-disk file safely)'
  }
}

/** 冲突检测：不可检视路径（symlink/escape）按冲突处理。 */
async function diskMatchesSnapshot(runtime: WorkspaceRuntime, workspaceDir: string, ref: string, path: string): Promise<boolean> {
  try {
    const { currentState } = await import('./git-snapshot')
    return classifyUndo(await currentState(workspaceDir, path), await stateAt(runtime.store, ref, path)) !== 'conflict'
  }
  catch {
    return false
  }
}

/** 有界并发 map：大路径数的 undo 计划不再一次起满量 git 子进程（P1-7）。 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

/** 单个 plan 的路径并发预算：每条路径内部还有多次 git 子进程调用。 */
const PLAN_ENTRY_CONCURRENCY = 8

/**
 * 构建只读 undo 计划：每个路径的变化分类、磁盘是否仍匹配 turn 后快照、
 * before 快照是否超限（超限条目恢复时单文件失败，绝不静默）。
 */
export async function buildPlanEntries(runtime: WorkspaceRuntime, workspaceDir: string, target: TurnRow, paths: string[]): Promise<PlanEntry[]> {
  return mapWithConcurrency(paths, PLAN_ENTRY_CONCURRENCY, async (path) => {
    const beforeState = await stateAt(runtime.store, target.before_ref!, path)
    return {
      path,
      change: await classifyPathChange(runtime.store, target.before_ref!, target.after_ref!, path),
      conflict: !await diskMatchesSnapshot(runtime, workspaceDir, target.after_ref!, path),
      tooLarge: beforeState.kind === 'tooLarge',
      unsupported: beforeState.kind === 'unsupported',
    }
  })
}

function summarizeChanges(entries: PlanEntry[]): string {
  const counts = { modified: 0, created: 0, deleted: 0 }
  for (const entry of entries) counts[entry.change] += 1
  return `modified ${counts.modified}, created ${counts.created}, deleted ${counts.deleted}`
}

export interface PlanFormatOptions {
  preview?: boolean
  dryRun?: boolean
  withDiffs?: boolean
}

/** P1-4：计划输出的规模上限——清单条数与逐文件 diff 都有界，防 UI/上下文膨胀。 */
const MAX_LISTED_FILES = 200
const MAX_DIFF_FILES = 50

function capList<T>(items: T[], max: number): { shown: T[], total: number, omitted: number } {
  return { shown: items.slice(0, max), total: items.length, omitted: Math.max(0, items.length - max) }
}

function omittedNote(omitted: number, label: string): string {
  return `  …and ${omitted} more ${label} (not listed)`
}

export async function formatPlan(runtime: WorkspaceRuntime, target: TurnRow, entries: PlanEntry[], options: PlanFormatOptions): Promise<string> {
  const conflicts = entries.filter(entry => entry.conflict)
  const oversized = entries.filter(entry => entry.tooLarge)
  const unsupported = entries.filter(entry => entry.unsupported)
  const lines: string[] = []
  lines.push(`${options.preview ? 'Undo preview' : options.dryRun ? 'Undo plan' : 'Undo preflight'}: turn ${target.turn_id}; ${entries.length} file(s) (${summarizeChanges(entries)}); ${conflicts.length} conflict(s).`)
  const listing = capList(entries.map(entry => `${entry.change.padEnd(8)} ${entry.path}${entry.conflict ? ' [conflict]' : ''}${entry.tooLarge ? ' [too large]' : ''}${entry.unsupported ? ' [unsupported]' : ''}`), MAX_LISTED_FILES)
  for (const line of listing.shown)
    lines.push(`  ${line}`)
  if (listing.omitted > 0)
    lines.push(omittedNote(listing.omitted, 'file(s)'))
  if (oversized.length > 0) {
    lines.push('')
    lines.push(`Oversized files (over the ${MAX_FILE_BYTES / (1024 * 1024)} MB restore limit) cannot be restored by this undo; they will be reported as not restored:`)
    for (const entry of oversized)
      lines.push(`  ${entry.path}`)
  }
  if (unsupported.length > 0) {
    lines.push('')
    lines.push('Unrestorable entries (symlinks and other unsupported types in the before snapshot) will be reported as not restored; recreate them manually if intended:')
    for (const entry of unsupported)
      lines.push(`  ${entry.path}`)
  }
  if (options.preview || options.withDiffs) {
    lines.push('')
    lines.push('Undo will apply (turn output → restored state):')
    const diffFiles = capList(entries, MAX_DIFF_FILES)
    for (const entry of diffFiles.shown) {
      const diff = await snapshotFileDiff(runtime.store, target.after_ref!, target.before_ref!, entry.path)
      lines.push(`--- ${entry.path}`)
      lines.push(diff ? indent(diff, '  ') : '  (no textual diff)')
    }
    if (diffFiles.omitted > 0)
      lines.push(omittedNote(diffFiles.omitted, 'diff(s)'))
  }
  if (conflicts.length > 0) {
    lines.push('')
    lines.push('Conflicts (turn output → current disk; undo would overwrite these changes):')
    const conflictFiles = capList(conflicts, MAX_DIFF_FILES)
    for (const entry of conflictFiles.shown) {
      const diff = await safeDiffAgainstDisk(runtime.store, target.after_ref!, entry.path)
      lines.push(`--- ${entry.path}`)
      lines.push(diff ? indent(diff, '  ') : '  (no textual diff)')
    }
    if (conflictFiles.omitted > 0)
      lines.push(omittedNote(conflictFiles.omitted, 'conflict diff(s)'))
    if (!options.dryRun && !options.preview)
      lines.push('Re-run with --skip-conflicts to restore only the non-conflicted files, or --force to overwrite the conflicts.')
  }
  return lines.join('\n')
}

export interface NoticeMessage {
  id: string
  role: 'user'
  content: { type: 'text', text: string }[]
  source: {
    kind: 'plugin'
    plugin: string
    form: 'rewind-notice' | 'undo-unavailable-notice' | 'rewind-privacy-notice'
    sections: { name: string, text: string }[]
  }
}

const PLUGIN_NAME = 'dsh-tauri-turnrewind'

function createRewindNoticeMessage(notice: { notice_id: string, kind?: string, turns: string[], target_turn_id: string, paths: string[] }): NoticeMessage {
  const paths = notice.paths.map(path => `- ${path}`).join('\n')
  const turns = notice.turns.length > 0 ? notice.turns.join(', ') : notice.target_turn_id
  const text = notice.kind === 'redo'
    ? `[Turn rewind notice]\nA previous undo was redone; the file changes of these turns were re-applied: ${turns}.\n\nRe-applied files:\n${paths}\n\nTreat the current files on disk as authoritative. Re-read the listed files before making further edits.`
    : `[Turn rewind notice]\nThe workspace was reverted by these undo operations: ${turns}.\n\nReverted files in this operation:\n${paths}\n\nTreat the current files on disk as authoritative. Do not assume any reverted changes still exist; re-read the listed files before making further edits.`
  return {
    id: `turnrewind-notice-${notice.notice_id}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: 'rewind-notice',
      sections: [{ name: PLUGIN_NAME, text }],
    },
  }
}

function createSensitiveNoticeMessage(notice: { notice_id: string, paths: string[] }): NoticeMessage {
  const paths = notice.paths.map(path => `- ${path}`).join('\n')
  const text = [
    '[Turn rewind privacy notice]',
    'These sensitive-looking files are NOT ignored by the repository\'s ignore rules, so they are captured into the private snapshot repo and restored by /undo:',
    paths,
    '',
    'If that is not intended, add them to .gitignore or .git/info/exclude — the snapshot scope follows the repository\'s ignore rules on every capture.',
  ].join('\n')
  return {
    id: `turnrewind-notice-${notice.notice_id}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: 'rewind-privacy-notice',
      sections: [{ name: PLUGIN_NAME, text }],
    },
  }
}

function createUnsupportedNoticeMessage(notice: { notice_id: string, reason: string | null }): NoticeMessage {
  const text = `[Turn rewind unavailable]\nUndo is disabled for this workspace.\nReason: ${notice.reason}\n\nTurns here still run normally, but their file changes are not recorded, so /undo cannot revert them. Move this session to a normal project directory if you want undoable turns.`
  return {
    id: `turnrewind-notice-${notice.notice_id}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: 'undo-unavailable-notice',
      sections: [{ name: PLUGIN_NAME, text }],
    },
  }
}

export function createNoticeMessage(notice: { notice_id: string, kind?: string, reason?: string | null, turns?: string[], target_turn_id?: string | null, paths?: string[] }): NoticeMessage {
  if (notice.kind === 'sensitive-files')
    return createSensitiveNoticeMessage({ notice_id: notice.notice_id, paths: notice.paths ?? [] })
  if (notice.kind === 'unsupported')
    return createUnsupportedNoticeMessage({ notice_id: notice.notice_id, reason: notice.reason ?? '' })
  return createRewindNoticeMessage({
    notice_id: notice.notice_id,
    kind: notice.kind,
    turns: notice.turns ?? [],
    target_turn_id: notice.target_turn_id ?? '',
    paths: notice.paths ?? [],
  })
}

/** 共享 undo 执行器（命令路径与确认 HTTP 路由共用）。 */
export async function executeUndoRestore(
  runtime: WorkspaceRuntime,
  params: { sessionId: string, workspaceKey: string, target: TurnRow, paths: string[], entries: PlanEntry[], skipConflicts?: boolean },
): Promise<string> {
  const { sessionId, workspaceKey, target, paths, entries, skipConflicts } = params
  // 跨进程互斥（P1-1）：operation 快照、文件恢复与账本事务与另一个进程
  // 对同一 workspace 的 capture/settle/undo 互斥；忙等 10s 后显式报错。
  const lock = await acquireWorkspaceLock(runtime.store.rootDir, runtime.workspaceDir, { waitMs: 10000 })
  try {
    const operationId = randomUUID()
    const beforeRef = `refs/turnrewind/operation-${operationId}`
    await captureSnapshot(runtime.store, beforeRef, `turnrewind undo ${target.turn_id}`, runtime.parentRef)
    createOperation(runtime.db, {
      operationId,
      kind: 'undo',
      targetTurnId: target.turn_id,
      requestedAt: new Date().toISOString(),
      beforeRef,
    })

    try {
      const targets = skipConflicts ? entries.filter(entry => !entry.conflict) : entries
      const restoredPaths: string[] = []
      const failedPaths: { path: string, reason: string }[] = []
      for (const entry of targets) {
        // P1-3: symlink/其他不可恢复类型的快照条目直接跳过并上报，
        // 不再伪装成普通文件写回（restorePath 内还有同规则的双保险）。
        if (entry.unsupported) {
          failedPaths.push({ path: entry.path, reason: 'TURNREWIND_UNSUPPORTED_TARGET: snapshot entry is a symlink or otherwise unrestorable' })
          continue
        }
        try {
          await restorePath(runtime.store, target.before_ref!, entry.path)
          restoredPaths.push(entry.path)
        }
        catch (error) {
          // One unrestorable file (oversized blob, unsupported target) must not
          // abort the whole undo: the other files still restore, and the failure
          // is reported per path instead of triggering a full rollback.
          failedPaths.push({ path: entry.path, reason: String((error as Error).message ?? error) })
        }
      }
      const skippedPaths = skipConflicts
        ? entries.filter(entry => entry.conflict).map(entry => entry.path)
        : []
      // 单事务完成 turn/operation/notice；含 notRestored 明细，部分失败
      // 持久化进 operation.error 与 notice（P0-5）。状态漂移或事务失败时
      // operation 落 needs-recovery，由启动围栏拦截（P0-3）。
      completeUndoTransaction(runtime.db, {
        noticeId: randomUUID(),
        sessionId,
        workspaceKey,
        targetTurnId: target.turn_id,
        restoredPaths,
        notRestored: failedPaths,
        operationId,
        createdAt: new Date().toISOString(),
      })
      runtime.parentRef = beforeRef
      let text = `Undid turn ${target.turn_id} and restored ${restoredPaths.length} file(s). The next model request will receive a rewind notice.`
      if (skippedPaths.length > 0)
        text += ` Skipped ${skippedPaths.length} conflicted file(s): ${skippedPaths.join(', ')}.`
      if (failedPaths.length > 0)
        text += ` Not restored (${failedPaths.length} file(s)): ${failedPaths.map(failure => `${failure.path} (${failure.reason.includes('TURNREWIND_FILE_TOO_LARGE') ? 'over the size limit' : failure.reason})`).join('; ')}.`
      return text
    }
    catch (error) {
      let rollbackError: unknown = null
      try {
        // `beforeRef` is the state immediately before this operation. Restore every
        // path this operation actually touched - with --skip-conflicts the skipped
        // conflicted files were never written, so rolling them back here would
        // overwrite the human edits the user explicitly chose to keep.
        const rollbackPaths = skipConflicts ? entries.filter(entry => !entry.conflict).map(entry => entry.path) : paths
        for (const path of rollbackPaths)
          await restorePath(runtime.store, beforeRef, path)
        settleOperation(runtime.db, operationId, 'rolled_back', error)
      }
      catch (rollbackFailure) {
        rollbackError = rollbackFailure
      }
      if (rollbackError)
        throw new Error(`Undo and automatic recovery both failed: ${String(error)}; rollback failed: ${String(rollbackError)}`)
      throw new Error(`Undo failed and the pre-undo file state was restored: ${String(error)}`)
    }
  }
  finally {
    lock.release()
  }
}

export async function turnRefsExist(store: SnapshotStore, turn: TurnRow): Promise<boolean> {
  if (!turn.before_ref || !turn.after_ref)
    return false
  return Boolean(
    await gitRef(store.repoDir, store.workspaceDir, turn.before_ref)
    && await gitRef(store.repoDir, store.workspaceDir, turn.after_ref),
  )
}

export interface WorkspaceEnv {
  workspaceForAgent: (agent: { session: { header?: { cwd?: string } } }) => string | undefined
  workspaceIssue: (dir: string) => string | undefined
  workspaceKeyFor: (path: string) => string
}

export interface ActiveTurnEntry {
  workspaceKey: string
  sessionId: string
}

export function workspaceHasActiveTurn(active: Map<string, unknown>, workspaceKey: string): boolean {
  for (const entry of active.values() as IterableIterator<ActiveTurnEntry>) {
    if (entry.workspaceKey === workspaceKey)
      return true
  }
  return false
}

export function workspaceHasActiveTurnForOtherSession(active: Map<string, unknown>, workspaceKey: string, sessionId: string): boolean {
  for (const entry of active.values() as IterableIterator<ActiveTurnEntry>) {
    if (entry.workspaceKey === workspaceKey && entry.sessionId !== sessionId)
      return true
  }
  return false
}

export async function applyUndo(
  runtime: WorkspaceRuntime,
  active: Map<string, unknown>,
  invocation: UndoInvocation,
  env: WorkspaceEnv = { workspaceForAgent, workspaceIssue, workspaceKeyFor },
): Promise<UndoOutcome> {
  const parsed = parseUndoInput(invocation.rawInput)
  if ('error' in parsed)
    return { kind: 'error', text: parsed.error }
  // 功能冻结闸门（2026-09-03 审查 P0-4 决策）：redo 先禁用、暂不开放。
  // 底层加固已落地并保留测试（applying operation / 失败明细 / needs-recovery
  // 事务），重新开放时把本分支换回 `return applyRedo(...)` 即可。
  if (parsed.redo)
    return { kind: 'error', text: '/undo --redo is temporarily disabled. The most recent undo cannot be re-applied for now.' }

  const workspaceDir = env.workspaceForAgent(invocation.agent)
  if (!workspaceDir) {
    // The hard guard refused the cwd; report the actual reason when there is one.
    const cwd = invocation.agent?.session?.header?.cwd
    const issue = typeof cwd === 'string' && cwd.length > 0 ? env.workspaceIssue(resolve(cwd)) : undefined
    if (issue)
      return { kind: 'error', text: `Undo is unavailable for this workspace. ${issue}` }
    return { kind: 'error', text: 'Undo is unavailable because this session has no workspace.' }
  }
  const workspaceKey = env.workspaceKeyFor(workspaceDir)
  if (workspaceHasActiveTurn(active, workspaceKey))
    return { kind: 'error', text: 'Undo is unavailable while an Agent turn is still active in this workspace.' }
  if (runtime.undoing)
    return { kind: 'error', text: 'Another undo operation is already running in this workspace.' }

  if (parsed.redo)
    return applyRedo(runtime, invocation, workspaceDir, workspaceKey)

  // Pending-plan lifecycle: --cancel marks a parked plan cancelled; --confirm
  // validates it and falls through to execution below.
  if (parsed.cancel) {
    const removed = markPendingPlanCancelled(runtime.db, parsed.turnId!, invocation.agent.session.id)
    return { kind: 'success', text: removed ? 'Pending undo cancelled.' : 'No pending undo plan matched (it may have expired or already run).' }
  }

  let target: TurnRow | undefined
  let planRow: (PendingPlanRow & { paths: string[] }) | undefined
  let pendingPlanClaimed = false
  let pendingPlanCommitted = false
  const abortPendingPlanClaim = (): void => {
    if (pendingPlanClaimed) {
      releasePendingPlanClaim(runtime.db, parsed.turnId!)
      pendingPlanClaimed = false
    }
    runtime.undoing = false
  }
  // Target selection runs BEFORE the execution try/finally below, so a thrown
  // probe (SQLite IOERR/BUSY while reading the ledger) must release the
  // reservation and any claimed plan explicitly. A stranded runtime.undoing
  // would silently refuse every later undo AND make new turns skip their
  // baseline (TURNREWIND_WORKSPACE_BUSY) until the host restarts.
  try {
    if (parsed.confirm) {
      const claim = claimPendingPlan(runtime.db, parsed.turnId!, invocation.agent.session.id)
      if (!claim.ok)
        return { kind: 'error', text: claim.error }
      pendingPlanClaimed = true
      // Reserve the workspace before the first await so another confirm route
      // cannot start a concurrent restore during snapshot validation.
      runtime.undoing = true
      planRow = claim.row
      const pendingTurnId = claim.row.turn_id
      target = getTurn(runtime.db, pendingTurnId)
      if (!target || !await turnRefsExist(runtime.store, target)) {
        abortPendingPlanClaim()
        return { kind: 'error', text: 'The pending plan\'s snapshot data no longer exists. Run /undo again to preview a fresh plan.' }
      }
    }
    else if (parsed.turnId) {
      // Reserve before the first await so a concurrent direct-execute cannot
      // build a plan against disk state this invocation is about to change.
      runtime.undoing = true
      target = getTurn(runtime.db, parsed.turnId)
      if (target && !await turnRefsExist(runtime.store, target)) {
        runtime.undoing = false
        return {
          kind: 'error',
          text: `The snapshot data for turn ${parsed.turnId} no longer exists (the snapshot repository was previously wiped); its changes can no longer be undone.`,
        }
      }
    }
    else {
      runtime.undoing = true
      // Walk newest-first and skip turns whose snapshot refs died with a wiped
      // snapshot repository, marking them so later /undo runs never re-check.
      for (const candidate of listReversibleTurns(runtime.db, invocation.agent.session.id, workspaceKey)) {
        if (await turnRefsExist(runtime.store, candidate)) {
          target = candidate
          break
        }
        markTurnSnapshotMissing(runtime.db, candidate.turn_id)
      }
    }
  }
  catch (error) {
    abortPendingPlanClaim()
    throw error
  }
  if (!target) {
    runtime.undoing = false
    const latest = getLatestTurnSummary(runtime.db, invocation.agent.session.id, workspaceKey)
    const detail = latest
      ? ` Latest turn ${latest.turn_id} is ${latest.status} (reversible=${latest.reversible}).`
      : ''
    return { kind: 'error', text: `No reversible turn was found for this session.${detail}` }
  }
  const ownershipError = assertSessionOwner(target, invocation.agent)
  if (ownershipError) {
    runtime.undoing = false
    abortPendingPlanClaim()
    return ownershipError
  }
  if (target.workspace_key !== workspaceKey) {
    runtime.undoing = false
    abortPendingPlanClaim()
    return { kind: 'error', text: 'The selected turn belongs to another workspace.' }
  }
  if (!['settled', 'interrupted'].includes(target.status) || target.reversible !== 1 || !target.before_ref || !target.after_ref) {
    runtime.undoing = false
    abortPendingPlanClaim()
    return { kind: 'error', text: 'The selected turn does not have a complete reversible snapshot.' }
  }

  runtime.undoing = true
  try {
    const paths = await snapshotDiff(runtime.store, target.before_ref, target.after_ref)
    // 计划漂移校验（P1-2）：确认时的快照 ref 与重算 diff 必须与预览一致，
    // 保证「确认的就是预览时看到的」。漂移即释放 claim 并要求重新预览。
    if (planRow) {
      const drift = planDrift(planRow, target, paths)
      if (drift) {
        abortPendingPlanClaim()
        return { kind: 'error', text: `${drift} — run /undo again to preview a fresh plan.` }
      }
    }
    if (paths.length === 0) {
      if (pendingPlanClaimed) {
        markPendingPlanApplied(runtime.db, parsed.turnId!, invocation.agent.session.id, 'No file changes were recorded for this turn.')
        pendingPlanCommitted = true
      }
      return { kind: 'success', text: 'No file changes were recorded for this turn.' }
    }

    const entries = await buildPlanEntries(runtime, workspaceDir, target, paths)
    const conflicts = entries.filter(entry => entry.conflict)
    const directExecute = parsed.force || parsed.skipConflicts

    // Read-only plan/preview: never touch disk.
    if (parsed.dryRun)
      return { kind: 'success', text: await formatPlan(runtime, target, entries, parsed) }

    // Bare /undo and --preview park a pending plan; execution waits for the
    // ✓ button (which sends /undo --confirm <plan-id>) so the user cannot
    // accidentally skip the preview. The card always carries the per-file
    // diffs — seeing what will be reverted is the point of the preview.
    if (!directExecute && !parsed.confirm) {
      const planText = await formatPlan(runtime, target, entries, { ...parsed, withDiffs: true })
      if (conflicts.length > 0)
        return { kind: parsed.preview ? 'success' : 'error', text: planText }
      const planId = createPendingPlan(runtime.db, {
        sessionId: invocation.agent.session.id,
        workspaceKey,
        turnId: target.turn_id,
        paths,
        beforeRef: target.before_ref!,
        afterRef: target.after_ref!,
      })
      return {
        kind: 'success',
        text: `${planText}\nplan ${planId}\nSend /undo --confirm ${planId} to apply, or /undo --cancel ${planId} to dismiss.`,
      }
    }

    // Confirmed execution: re-verify nothing changed on disk since the
    // preview before overwriting anything.
    if (parsed.confirm && conflicts.length > 0) {
      abortPendingPlanClaim()
      return { kind: 'error', text: `The workspace changed since the preview (${conflicts.length} conflicted file(s)). Run /undo again to refresh the plan; use --force/--skip-conflicts deliberately if needed.` }
    }

    try {
      const text = await executeUndoRestore(runtime, {
        sessionId: invocation.agent.session.id,
        workspaceKey,
        target,
        paths,
        entries,
        skipConflicts: parsed.skipConflicts,
      })
      if (parsed.confirm) {
        markPendingPlanApplied(runtime.db, parsed.turnId!, invocation.agent.session.id, text)
        pendingPlanCommitted = true
      }
      return { kind: 'success', text }
    }
    catch (error) {
      return { kind: 'error', text: String((error as Error)?.message ?? error) }
    }
  }
  finally {
    if (pendingPlanClaimed && !pendingPlanCommitted)
      abortPendingPlanClaim()
    else
      runtime.undoing = false
  }
}
