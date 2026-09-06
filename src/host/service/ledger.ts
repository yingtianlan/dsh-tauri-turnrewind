/**
 * host/service/ledger.ts — SQLite 账本（turns / operations / notices / pending plans）。
 *
 * WAL 模式；所有多写点变更走单事务（BEGIN/COMMIT）。turn 生命周期、undo 计划、
 * 一次性提示与恢复围栏（needs-recovery）的持久状态都住在这里。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'pathe'
import { PENDING_PLAN_TTL_MS } from '../constants'

/** 账本备份间隔（24h）：ledger.sqlite.bak 是损坏时的唯一自愈来源。 */
const LEDGER_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS workspaces (
    workspace_key TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    snapshot_repo TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_turn_id TEXT,
    workspace_key TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    settled_at TEXT,
    before_ref TEXT,
    after_ref TEXT,
    reversible INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_turn_id TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    settled_at TEXT,
    outcome TEXT,
    before_ref TEXT,
    after_ref TEXT,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS rewind_notices (
    notice_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    target_turn_id TEXT,
    turns_json TEXT NOT NULL DEFAULT '[]',
    paths_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    kind TEXT NOT NULL DEFAULT 'rewind',
    reason TEXT
  );
  CREATE TABLE IF NOT EXISTS pending_plans (
    plan_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    paths_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result_text TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id, started_at);
  CREATE INDEX IF NOT EXISTS turns_workspace_idx ON turns(workspace_key, settled_at);
  CREATE INDEX IF NOT EXISTS operations_target_idx ON operations(target_turn_id);
  CREATE INDEX IF NOT EXISTS rewind_notices_session_idx ON rewind_notices(session_id, status, created_at);
`

export interface TurnRow {
  turn_id: string
  session_id: string
  parent_turn_id: string | null
  workspace_key: string
  status: string
  started_at: string
  settled_at: string | null
  before_ref: string | null
  after_ref: string | null
  reversible: number
  error: string | null
}

export interface OperationRow {
  operation_id: string
  kind: string
  target_turn_id: string
  requested_at: string
  settled_at: string | null
  outcome: string | null
  before_ref: string | null
  after_ref: string | null
  error: string | null
}

export interface NoticeRow {
  notice_id: string
  session_id: string
  workspace_key: string
  target_turn_id: string | null
  turns_json: string
  paths_json: string
  status: string
  created_at: string
  claimed_at: string | null
  kind: string
  reason: string | null
}

export interface PendingPlanRow {
  plan_id: string
  session_id: string
  workspace_key: string
  turn_id: string
  paths_json: string
  status: string
  result_text: string | null
  created_at: string
  expires_at: string
  /** 预览时的快照绑定（P1-2）；旧格式行为 NULL，confirm 时跳过严格校验。 */
  before_ref: string | null
  after_ref: string | null
  paths_digest: string | null
}

export type Ledger = DatabaseSync

/**
 * 滚动备份：VACUUM INTO 输出一致性快照（WAL 下亦然），写 .pending 后原子
 * 改名，失败不阻断打开（openLedger 无 logger 注入，console.warn 兜底一行）。
 * 独立导出：测试可强制补拍（TTL 内的二次备份默认跳过）。
 */
export function backupLedger(db: Ledger, dbPath: string, { force = false }: { force?: boolean } = {}): void {
  const backupPath = `${dbPath}.bak`
  try {
    const stat = statSync(backupPath, { throwIfNoEntry: false })
    if (!force && stat && Date.now() - stat.mtimeMs < LEDGER_BACKUP_INTERVAL_MS)
      return
    const pending = `${backupPath}.pending`
    rmSync(pending, { force: true })
    db.exec(`VACUUM INTO '${pending.replaceAll('\'', '\'\'')}'`)
    rmSync(backupPath, { force: true })
    renameSync(pending, backupPath)
  }
  catch (error) {
    console.warn(`turnrewind: ledger backup failed (continuing): ${String(error)}`)
  }
}

export function openLedger(rootDir: string): Ledger {
  const path = join(rootDir, 'ledger.sqlite')
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // P1-7: 并发写遇 SQLITE_BUSY 时等待而非立即抛错——瞬时锁冲突不应被
  // 上层误判为状态漂移并触发永久围栏。
  db.exec('PRAGMA busy_timeout = 5000')
  // 生产保险：损坏账本宁可显式拒绝加载（undo 不可用、turn 照常执行），
  // 也不要在半 corrupt 的库上继续写入扩大损伤。恢复路径：用 ledger.sqlite.bak
  // 还原，或清空数据目录重建。拒绝前必须关闭句柄（否则 Windows 上文件被锁，
  // 用户连还原备份都做不到）。
  let check: { quick_check?: string } | undefined
  try {
    check = db.prepare('PRAGMA quick_check(1)').get() as { quick_check?: string } | undefined
  }
  catch (error) {
    db.close()
    throw new Error(`TURNREWIND_LEDGER_CORRUPT: ${path}: ${(error as Error).message}`)
  }
  if (check?.quick_check !== 'ok') {
    db.close()
    throw new Error(`TURNREWIND_LEDGER_CORRUPT: ${path}: ${check?.quick_check ?? 'unreadable'} — restore ledger.sqlite.bak or clear the data dir`)
  }
  db.exec(SCHEMA)
  // Older local prototypes may already have the table; add new columns idempotently.
  for (const migration of [
    'ALTER TABLE operations ADD COLUMN after_ref TEXT',
    'ALTER TABLE rewind_notices ADD COLUMN turns_json TEXT NOT NULL DEFAULT \'[]\'',
    'ALTER TABLE rewind_notices ADD COLUMN kind TEXT NOT NULL DEFAULT \'rewind\'',
    'ALTER TABLE rewind_notices ADD COLUMN reason TEXT',
    'ALTER TABLE pending_plans ADD COLUMN status TEXT NOT NULL DEFAULT \'pending\'',
    'ALTER TABLE pending_plans ADD COLUMN result_text TEXT',
    'ALTER TABLE pending_plans ADD COLUMN before_ref TEXT',
    'ALTER TABLE pending_plans ADD COLUMN after_ref TEXT',
    'ALTER TABLE pending_plans ADD COLUMN paths_digest TEXT',
  ]) {
    try {
      db.exec(migration)
    }
    catch {
      // Column already exists.
    }
  }
  // Reopen fence: active turns from a previous host process become
  // abandoned; applying operations become needs-recovery (their workspace
  // refuses new rewind work until purged). Expired plans are swept too.
  db.exec(`UPDATE turns SET status = 'abandoned', reversible = 0, error = 'plugin restarted during active turn' WHERE status = 'active'`)
  db.prepare(`UPDATE operations SET outcome = 'needs-recovery', settled_at = COALESCE(settled_at, ?), error = 'plugin restarted while the operation was applying; workspace recovery is required' WHERE outcome = 'applying'`).run(new Date().toISOString())
  // P2-11: 崩溃残留的 applying plan 精确清扫——
  //   目标 turn 已 undone → undo 事务实际完成：plan 标 applied（结果如实）；
  //   否则执行状态未知（操作已转 needs-recovery 围栏接管）：plan 转 expired。
  db.prepare(`
    UPDATE pending_plans SET status = 'applied',
      result_text = COALESCE(result_text, 'host restarted while this plan was applying; the undo was applied')
    WHERE status = 'applying'
      AND EXISTS (SELECT 1 FROM turns WHERE turns.turn_id = pending_plans.turn_id AND turns.status = 'undone')
  `).run()
  db.prepare(`UPDATE pending_plans SET status = 'expired', result_text = COALESCE(result_text, 'host restarted while this plan was applying') WHERE status = 'applying'`).run()
  prunePendingPlans(db)
  backupLedger(db, path)
  return db
}

/**
 * 失效 plan 清扫：过期的 pending 行转为 `expired` 永久留档，不删除。
 *
 * 过期只锁执行（confirm 路径按状态拒绝），不抹掉审计记录：卡片里的文件
 * 清单与 diff 来自命令输出文本（对话内永久存在），plan 行保留后状态轮询
 * 返回 expired，用户随时可以回看「当时预览了什么」。settled 行
 * （applied/cancelled）同样永远保留。
 */
export function prunePendingPlans(db: Ledger): void {
  db.prepare('UPDATE pending_plans SET status = \'expired\' WHERE status = \'pending\' AND expires_at < ?')
    .run(new Date().toISOString())
}

export function registerWorkspace(db: Ledger, workspaceKey: string, workspacePath: string, snapshotRepo: string): void {
  db.prepare(`
    INSERT INTO workspaces(workspace_key, workspace_path, snapshot_repo, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_key) DO UPDATE SET workspace_path = excluded.workspace_path, snapshot_repo = excluded.snapshot_repo
  `).run(workspaceKey, workspacePath, snapshotRepo, new Date().toISOString())
}

export function insertTurn(db: Ledger, turn: { turnId: string, sessionId: string, workspaceKey: string, startedAt: string, beforeRef?: string }): void {
  db.prepare(`
    INSERT INTO turns(turn_id, session_id, workspace_key, status, started_at, before_ref)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(turn.turnId, turn.sessionId, turn.workspaceKey, turn.startedAt, turn.beforeRef ?? null)
}

export function getTurn(db: Ledger, turnId: string): TurnRow | undefined {
  return db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(turnId) as unknown as TurnRow | undefined
}

export function getLatestSnapshotRef(db: Ledger, workspaceKey: string): string | undefined {
  return (db.prepare(`
    SELECT after_ref FROM turns
    WHERE workspace_key = ? AND after_ref IS NOT NULL
    ORDER BY settled_at DESC LIMIT 1
  `).get(workspaceKey) as { after_ref?: string } | undefined)?.after_ref
}

export function listChildren(db: Ledger, parentTurnId: string): TurnRow[] {
  return db.prepare('SELECT * FROM turns WHERE parent_turn_id = ? ORDER BY started_at ASC').all(parentTurnId) as unknown as TurnRow[]
}

export function createOperation(db: Ledger, operation: { operationId: string, kind: string, targetTurnId: string, requestedAt: string, beforeRef?: string }): void {
  db.prepare(`
    INSERT INTO operations(operation_id, kind, target_turn_id, requested_at, outcome, before_ref)
    VALUES (?, ?, ?, ?, 'applying', ?)
  `).run(operation.operationId, operation.kind, operation.targetTurnId, operation.requestedAt, operation.beforeRef ?? null)
}

export function settleOperation(db: Ledger, operationId: string, outcome: string, error?: unknown): void {
  db.prepare('UPDATE operations SET settled_at = ?, outcome = ?, error = ? WHERE operation_id = ?')
    .run(new Date().toISOString(), outcome, error ? String(error) : null, operationId)
}

export interface RewindNotice {
  noticeId: string
  sessionId: string
  workspaceKey: string
  targetTurnId: string
  paths: string[]
  createdAt: string
  kind?: string
}

export function queueRewindNotice(db: Ledger, notice: RewindNotice): void {
  db.prepare(`
    INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, status, created_at, kind)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    notice.noticeId,
    notice.sessionId,
    notice.workspaceKey,
    notice.targetTurnId,
    JSON.stringify([notice.targetTurnId]),
    JSON.stringify(notice.paths),
    notice.createdAt,
    notice.kind ?? 'undo',
  )
}

/** 消费即返回的 notice：列名直通 + 解析后的 turns/paths。 */
export interface ClaimedNotice extends NoticeRow {
  turns: string[]
  paths: string[]
}

export function claimRewindNotices(db: Ledger, sessionId: string, workspaceKey: string): ClaimedNotice[] {
  const claimedAt = new Date().toISOString()
  // BEGIN IMMEDIATE + 事务内 SELECT：读取与消费在同一个写锁内完成，两个
  // 并发 claim（双 Host 进程）不可能读到同一批 pending 行——事务外的
  // 预读会让第二个调用者返回 0 行更新却仍吐出整批 notice。
  db.exec('BEGIN IMMEDIATE')
  try {
    const notices = db.prepare(`
      SELECT * FROM rewind_notices
      WHERE session_id = ? AND workspace_key = ? AND status = 'pending'
      ORDER BY created_at ASC
    `).all(sessionId, workspaceKey) as unknown as NoticeRow[]
    if (notices.length === 0) {
      db.exec('COMMIT')
      return []
    }
    const statement = db.prepare(`
      UPDATE rewind_notices SET status = 'consumed', claimed_at = ?
      WHERE notice_id = ? AND status = 'pending'
    `)
    for (const notice of notices)
      statement.run(claimedAt, notice.notice_id)
    db.exec('COMMIT')
    // Rows pass through verbatim (snake_case): the JS tests and the host's
    // message builder both consume raw column names.
    return notices.map(notice => ({
      ...notice,
      paths: JSON.parse(notice.paths_json),
      turns: JSON.parse(notice.turns_json || '[]'),
    }))
  }
  catch (error) {
    // ROLLBACK 自身失败（如 BEGIN 未生效）不能掩盖原始错误。
    try {
      db.exec('ROLLBACK')
    }
    catch { /* no active transaction */ }
    throw error
  }
}

export function listNeedsRecoveryWorkspaces(db: Ledger): string[] {
  return (db.prepare(`
    SELECT DISTINCT t.workspace_key
    FROM operations o
    JOIN turns t ON t.turn_id = o.target_turn_id
    WHERE o.outcome = 'needs-recovery'
  `).all() as { workspace_key: string }[]).map(row => row.workspace_key)
}

/**
 * 敏感文件提醒的去重查询：每会话+工作区只发一条（kind 'sensitive-files'）。
 * 独立导出：baselineTask 用它避免每 turn 都跑扫描。
 */
export function hasSensitiveNotice(db: Ledger, sessionId: string, workspaceKey: string): boolean {
  return db.prepare(`
    SELECT 1 FROM rewind_notices
    WHERE session_id = ? AND workspace_key = ? AND kind = 'sensitive-files'
    LIMIT 1
  `).get(sessionId, workspaceKey) !== undefined
}

/** 写入敏感文件提醒（kind 'sensitive-files'，reason 携带文件清单）；重复为 no-op。 */
export function queueSensitiveNotice(db: Ledger, sessionId: string, workspaceKey: string, files: string[]): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (hasSensitiveNotice(db, sessionId, workspaceKey)) {
      db.exec('COMMIT')
      return false
    }
    db.prepare(`
      INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, kind, reason, status, created_at)
      VALUES (?, ?, ?, 'workspace-sensitive', '[]', ?, 'sensitive-files', ?, 'pending', ?)
    `).run(randomUUID(), sessionId, workspaceKey, JSON.stringify(capNoticePaths(files)), files.join('; '), new Date().toISOString())
    db.exec('COMMIT')
    return true
  }
  catch (error) {
    try {
      db.exec('ROLLBACK')
    }
    catch { /* no active transaction */ }
    throw error
  }
}

/** 恢复面板行：一个被围 workspace 的 needs-recovery 操作明细。 */
export interface RecoveryWorkspace {
  workspace_key: string
  workspace_path: string | null
  operations: {
    operation_id: string
    kind: string
    target_turn_id: string
    requested_at: string
    settled_at: string | null
    error: string | null
  }[]
}

/** 恢复面板数据源：按 workspace 分组的围栏明细（供 UI 与 recover 路由）。 */
export function listRecoveryWorkspaces(db: Ledger): RecoveryWorkspace[] {
  const rows = db.prepare(`
    SELECT o.operation_id AS operation_id, o.kind AS kind, o.target_turn_id AS target_turn_id,
           o.requested_at AS requested_at, o.settled_at AS settled_at, o.error AS error,
           t.workspace_key AS workspace_key, w.workspace_path AS workspace_path
    FROM operations o
    JOIN turns t ON t.turn_id = o.target_turn_id
    LEFT JOIN workspaces w ON w.workspace_key = t.workspace_key
    WHERE o.outcome = 'needs-recovery'
    ORDER BY COALESCE(o.settled_at, o.requested_at) DESC
  `).all() as unknown as (RecoveryWorkspace['operations'][number] & { workspace_key: string, workspace_path: string | null })[]
  const byWorkspace = new Map<string, RecoveryWorkspace>()
  for (const row of rows) {
    let entry = byWorkspace.get(row.workspace_key)
    if (!entry) {
      entry = { workspace_key: row.workspace_key, workspace_path: row.workspace_path, operations: [] }
      byWorkspace.set(row.workspace_key, entry)
    }
    entry.operations.push({
      operation_id: row.operation_id,
      kind: row.kind,
      target_turn_id: row.target_turn_id,
      requested_at: row.requested_at,
      settled_at: row.settled_at,
      error: row.error,
    })
  }
  return [...byWorkspace.values()]
}

/**
 * 用户确认「已人工检查该 workspace」后解除恢复围栏：该 workspace 的全部
 * needs-recovery 操作转为 recovery-acknowledged 终态。账本行保留审计；
 * 围栏查询只认 needs-recovery，改写即解锁，重启清扫也不再触碰（它只扫
 * applying）。返回改写行数。
 */
export function acknowledgeRecovery(db: Ledger, workspaceKey: string): number {
  return Number(db.prepare(`
    UPDATE operations SET outcome = 'recovery-acknowledged',
      error = COALESCE(error, '') || ' [recovery acknowledged at ' || ? || ']'
    WHERE outcome = 'needs-recovery'
      AND target_turn_id IN (SELECT turn_id FROM turns WHERE workspace_key = ?)
  `).run(new Date().toISOString(), workspaceKey).changes)
}

/**
 * P1-6：实时围栏查询。needs-recovery 可能发生在任意时刻（账本事务失败的
 * catch 路径），启动时加载的内存集合会过期——围栏判定一律查库。
 */
export function hasNeedsRecoveryWorkspace(db: Ledger, workspaceKey: string): boolean {
  return db.prepare(`
    SELECT 1
    FROM operations o
    JOIN turns t ON t.turn_id = o.target_turn_id
    WHERE o.outcome = 'needs-recovery' AND t.workspace_key = ?
    LIMIT 1
  `).get(workspaceKey) !== undefined
}

/** 预览路径集的稳定摘要：排序后 sha256。confirm 时校验计划是否漂移（P1-2）。 */
export function planPathsDigest(paths: string[]): string {
  return createHash('sha256').update([...paths].sort().join('\0')).digest('hex')
}

export function createPendingPlan(db: Ledger, plan: PendingPlan): string {
  db.exec('BEGIN IMMEDIATE')
  try {
    // One live plan per session+workspace: a newer preview replaces the older.
    // 被替换的旧 plan 转 expired 留档（审计可见），不再物理删除。
    db.prepare('UPDATE pending_plans SET status = \'expired\' WHERE session_id = ? AND workspace_key = ? AND status = \'pending\'')
      .run(plan.sessionId, plan.workspaceKey)
    const planId = randomUUID()
    const createdAt = new Date().toISOString()
    db.prepare(`
      INSERT INTO pending_plans(plan_id, session_id, workspace_key, turn_id, paths_json, before_ref, after_ref, paths_digest, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      planId,
      plan.sessionId,
      plan.workspaceKey,
      plan.turnId,
      JSON.stringify(plan.paths),
      plan.beforeRef,
      plan.afterRef,
      planPathsDigest(plan.paths),
      createdAt,
      new Date(Date.now() + PENDING_PLAN_TTL_MS).toISOString(),
    )
    db.exec('COMMIT')
    return planId
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export interface PendingPlan {
  sessionId: string
  workspaceKey: string
  turnId: string
  paths: string[]
  /** 预览时的 turn 快照 ref，confirm 时校验未被改写（P1-2）。 */
  beforeRef: string
  afterRef: string
}

/**
 * Atomically move one pending plan to `applying` so concurrent confirm/cancel
 * calls cannot interleave: the conditional UPDATE is serialized by SQLite, so
 * exactly one caller sees changes === 1 and everyone else gets a deterministic
 * failure. The pre-reads only pick a precise error code; the UPDATE decides.
 */
export function claimPendingPlan(db: Ledger, planId: string, sessionId: string): { ok: true, row: PendingPlanRow & { paths: string[] } } | { ok: false, code: number, error: string } {
  const row = db.prepare('SELECT * FROM pending_plans WHERE plan_id = ?').get(planId) as unknown as PendingPlanRow | undefined
  if (row === undefined)
    return { ok: false, code: 404, error: 'plan not found — run /undo again' }
  if (row.session_id !== sessionId)
    return { ok: false, code: 403, error: 'the plan belongs to another session' }
  // 过期 plan 转 expired 留档但拒绝执行：过期锁的是执行，不是查看。
  if (row.status === 'expired')
    return { ok: false, code: 410, error: 'this plan has expired — run /undo again to preview a fresh plan' }
  if (row.status !== 'pending')
    return { ok: false, code: 409, error: 'this plan was already applied, cancelled, or is being applied — run /undo again' }
  if (row.expires_at < new Date().toISOString()) {
    db.prepare('UPDATE pending_plans SET status = \'expired\' WHERE plan_id = ? AND status = \'pending\'').run(planId)
    return { ok: false, code: 410, error: 'this plan has expired — run /undo again to preview a fresh plan' }
  }
  const claimed = db.prepare(`
    UPDATE pending_plans SET status = 'applying'
    WHERE plan_id = ? AND session_id = ? AND status = 'pending'
  `).run(planId, sessionId)
  if (claimed.changes !== 1)
    return { ok: false, code: 409, error: 'this plan was already applied, cancelled, or is being applied — run /undo again' }
  return { ok: true, row: { ...row, paths: JSON.parse(row.paths_json) } }
}

/** Return an in-flight claim to `pending` after a failed confirm attempt. */
export function releasePendingPlanClaim(db: Ledger, planId: string): void {
  db.prepare(`
    UPDATE pending_plans SET status = 'pending'
    WHERE plan_id = ? AND status = 'applying'
  `).run(planId)
}

/**
 * Plan lookup for the confirm HTTP route: keyed by plan id only — the client
 * does not know the workspace key, the row itself carries it (and the owner
 * session, which the route re-checks against the caller).
 */
export function getPendingPlanRow(db: Ledger, planId: string): (PendingPlanRow & { paths: string[] }) | undefined {
  const row = db.prepare('SELECT * FROM pending_plans WHERE plan_id = ?').get(planId) as unknown as PendingPlanRow | undefined
  if (row === undefined)
    return undefined
  // 过期 pending 转 expired 留档并原样返回（status = 'expired'），
  // 由调用方按状态拒绝执行；行本身保留供审计查看。
  if (row.status === 'pending' && row.expires_at < new Date().toISOString()) {
    db.prepare('UPDATE pending_plans SET status = \'expired\' WHERE plan_id = ? AND status = \'pending\'').run(planId)
    row.status = 'expired'
  }
  return { ...row, paths: JSON.parse(row.paths_json) }
}

/** Dismissal from the ✕ button: workspace key is unknown client-side. */
export function markPendingPlanCancelled(db: Ledger, planId: string, sessionId: string): boolean {
  const result = db.prepare(`
    UPDATE pending_plans SET status = 'cancelled'
    WHERE plan_id = ? AND session_id = ? AND status = 'pending'
  `).run(planId, sessionId)
  return result.changes > 0
}

/** Outcome written by the confirm route so the client card can poll it. Only a claimed (`applying`) plan can be applied. */
export function markPendingPlanApplied(db: Ledger, planId: string, sessionId: string, message: string): void {
  db.prepare(`
    UPDATE pending_plans SET status = 'applied', result_text = ?
    WHERE plan_id = ? AND session_id = ? AND status = 'applying'
  `).run(message, planId, sessionId)
}

export function getPendingPlanStatus(db: Ledger, planId: string, sessionId: string): { status: string, resultText: string | null } | undefined {
  const row = db.prepare('SELECT plan_id, status, result_text, expires_at FROM pending_plans WHERE plan_id = ? AND session_id = ?').get(planId, sessionId) as unknown as { plan_id: string, status: string, result_text: string | null, expires_at: string } | undefined
  if (row === undefined)
    return undefined
  // 过期 pending 转 expired 留档：状态轮询如实回报，卡片保留留档视图但不再可执行。
  if (row.status === 'pending' && row.expires_at < new Date().toISOString()) {
    db.prepare('UPDATE pending_plans SET status = \'expired\' WHERE plan_id = ? AND status = \'pending\'').run(row.plan_id)
    row.status = 'expired'
  }
  return { status: row.status, resultText: row.result_text }
}

export function settleTurn(db: Ledger, turnId: string, afterRef: string): void {
  db.prepare('UPDATE turns SET status = \'settled\', settled_at = ?, after_ref = ?, reversible = 1 WHERE turn_id = ?')
    .run(new Date().toISOString(), afterRef, turnId)
}

export function settleNoopTurn(db: Ledger, turnId: string, afterRef: string): void {
  db.prepare('UPDATE turns SET status = \'settled\', settled_at = ?, after_ref = ?, reversible = 0, error = \'no file changes\' WHERE turn_id = ?')
    .run(new Date().toISOString(), afterRef, turnId)
}

export function settleInterruptedTurn(db: Ledger, turnId: string, afterRef: string, reason: string): void {
  db.prepare('UPDATE turns SET status = \'interrupted\', settled_at = ?, after_ref = ?, reversible = 1, error = ? WHERE turn_id = ?')
    .run(new Date().toISOString(), afterRef, reason, turnId)
}

export function failTurn(db: Ledger, turnId: string, error: unknown): void {
  db.prepare('UPDATE turns SET status = \'failed\', settled_at = ?, reversible = 0, error = ? WHERE turn_id = ?')
    .run(new Date().toISOString(), String(error), turnId)
}

export function skipTurn(db: Ledger, turn: { turnId: string, sessionId: string, workspaceKey: string, startedAt: string }, reason: string): void {
  db.prepare(`
    INSERT INTO turns(turn_id, session_id, workspace_key, status, started_at, settled_at, reversible, error)
    VALUES (?, ?, ?, 'skipped', ?, ?, 0, ?)
  `).run(turn.turnId, turn.sessionId, turn.workspaceKey, turn.startedAt, new Date().toISOString(), reason)
}

/** skipped turn + 每会话/工作区一次性 heads-up（去重由 rewind_notices 承担）。 */
export function recordSkippedTurn(db: Ledger, turn: { turnId: string, sessionId: string, workspaceKey: string, startedAt: string }, reason: string): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    skipTurn(db, turn, reason)
    // Queue one heads-up per session and workspace; repeated skips stay silent.
    const existing = db.prepare(`
      SELECT 1 FROM rewind_notices WHERE session_id = ? AND workspace_key = ? AND kind = 'unsupported' LIMIT 1
    `).get(turn.sessionId, turn.workspaceKey)
    if (!existing) {
      db.prepare(`
        INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, kind, reason, status, created_at)
        VALUES (?, ?, ?, 'workspace-unsupported', '[]', '[]', 'unsupported', ?, 'pending', ?)
      `).run(randomUUID(), turn.sessionId, turn.workspaceKey, reason, new Date().toISOString())
    }
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function markTurnSnapshotMissing(db: Ledger, turnId: string): void {
  db.prepare('UPDATE turns SET reversible = 0, error = \'snapshot ref missing (snapshot repository was wiped)\' WHERE turn_id = ?').run(turnId)
}

export function listReversibleTurns(db: Ledger, sessionId: string, workspaceKey: string): TurnRow[] {
  return db.prepare(`
    SELECT * FROM turns
    WHERE session_id = ? AND workspace_key = ? AND reversible = 1 AND status IN ('settled', 'interrupted')
    ORDER BY started_at DESC
  `).all(sessionId, workspaceKey) as unknown as TurnRow[]
}

export interface LatestTurnSummary {
  turn_id: string
  workspace_key: string
  status: string
  reversible: number
  settled_at: string | null
}

export function getLatestTurnSummary(db: Ledger, sessionId: string, workspaceKey?: string): LatestTurnSummary | undefined {
  if (workspaceKey === undefined) {
    return db.prepare(`
      SELECT turn_id, workspace_key, status, reversible, settled_at
      FROM turns WHERE session_id = ? ORDER BY started_at DESC LIMIT 1
    `).get(sessionId) as unknown as LatestTurnSummary | undefined
  }
  return db.prepare(`
    SELECT turn_id, workspace_key, status, reversible, settled_at
    FROM turns WHERE session_id = ? AND workspace_key = ? ORDER BY started_at DESC LIMIT 1
  `).get(sessionId, workspaceKey) as unknown as LatestTurnSummary | undefined
}

export function getLatestTurn(db: Ledger, sessionId: string, workspaceKey: string): TurnRow | undefined {
  return db.prepare(`
    SELECT * FROM turns
    WHERE session_id = ? AND workspace_key = ?
      AND reversible = 1
      AND status IN ('settled', 'interrupted')
    ORDER BY started_at DESC LIMIT 1
  `).get(sessionId, workspaceKey) as unknown as TurnRow | undefined
}

export function getLatestAppliedUndo(db: Ledger, sessionId: string, workspaceKey: string): OperationRow | undefined {
  return db.prepare(`
    SELECT * FROM operations
    WHERE kind = 'undo' AND outcome = 'applied'
      AND target_turn_id IN (SELECT turn_id FROM turns WHERE session_id = ? AND workspace_key = ?)
    ORDER BY settled_at DESC LIMIT 1
  `).get(sessionId, workspaceKey) as unknown as OperationRow | undefined
}

/** 消费超过 7 天的 notice 行删除；pending 与近期行保留（弹窗去重语义）。 */
export function pruneConsumedNotices(db: Ledger, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
  return Number(db.prepare('DELETE FROM rewind_notices WHERE status = \'consumed\' AND claimed_at < ?').run(cutoff).changes)
}

/** notice 路径清单上限（P1-4）：超出部分以摘要行代替，防账本行与模型上下文膨胀。 */
export const MAX_NOTICE_PATHS = 500

function capNoticePaths(paths: string[]): string[] {
  return paths.length > MAX_NOTICE_PATHS
    ? [...paths.slice(0, MAX_NOTICE_PATHS), `…and ${paths.length - MAX_NOTICE_PATHS} more path(s)`]
    : paths
}

/** undo 完成事务：turn → undone、operation → applied、notice 入队。 */
export interface UndoCompletion {
  noticeId: string
  sessionId: string
  workspaceKey: string
  targetTurnId: string
  restoredPaths: string[]
  /** 恢复失败的单路径清单（含原因），随 operation.error 与 notice 持久化。 */
  notRestored: { path: string, reason: string }[]
  operationId: string
  createdAt: string
}

/**
 * 完成一次 undo 的唯一入口：单事务内校验并落 turn/operation/notice。
 *
 * - turn 允许从 settled 或 interrupted 进入 undone（interrupted turn 的文件
 *   同样会被恢复，状态必须跟着走，否则会残留在可撤销列表里被重复 undo）；
 * - 两个 UPDATE 各带状态条件，changes !== 1 即状态漂移：事务回滚且
 *   operation 落 needs-recovery，交给启动围栏拦截该 workspace；
 * - 未恢复路径写入 operation.error 与 notice，让审计和 redo 知道部分失败。
 */
export function completeUndoTransaction(db: Ledger, completion: UndoCompletion): 'undone' | 'needs-recovery' {
  const summary = completion.notRestored.length > 0
    ? completion.notRestored.map(entry => `${entry.path} (${entry.reason})`).join('; ')
    : null
  db.exec('BEGIN IMMEDIATE')
  try {
    const turn = db.prepare(`
      UPDATE turns SET status = 'undone', settled_at = ?
      WHERE turn_id = ? AND status IN ('settled', 'interrupted') AND reversible = 1
    `).run(new Date().toISOString(), completion.targetTurnId)
    if (turn.changes !== 1)
      throw new Error(`TURN_STATE_MISMATCH: turn ${completion.targetTurnId} is not in a restorable state`)
    const operation = db.prepare(`
      UPDATE operations SET outcome = 'applied', settled_at = ?, error = ?
      WHERE operation_id = ? AND outcome = 'applying'
    `).run(new Date().toISOString(), summary, completion.operationId)
    if (operation.changes !== 1)
      throw new Error(`OPERATION_STATE_MISMATCH: operation ${completion.operationId} is not applying`)
    db.prepare(`
      INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, status, created_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'undo')
    `).run(
      completion.noticeId,
      completion.sessionId,
      completion.workspaceKey,
      completion.targetTurnId,
      JSON.stringify([completion.targetTurnId]),
      JSON.stringify(capNoticePaths([...completion.restoredPaths, ...completion.notRestored.map(entry => entry.path)])),
      completion.createdAt,
    )
    db.exec('COMMIT')
    return 'undone'
  }
  catch (error) {
    db.exec('ROLLBACK')
    // 账本未能完成：operation 落 needs-recovery，启动围栏将拦截该 workspace
    db.prepare(`
      UPDATE operations SET outcome = 'needs-recovery', settled_at = ?, error = ?
      WHERE operation_id = ? AND outcome = 'applying'
    `).run(new Date().toISOString(), String((error as Error).message), completion.operationId)
    throw error
  }
}

/** redo 完成事务的输入：旧 undo operation + 本次 redo 自己的 applying operation。 */
export interface RedoCompletion {
  noticeId: string
  sessionId: string
  workspaceKey: string
  targetTurnId: string
  /** 被重做的旧 undo operation（applied 状态）。 */
  redoneOperationId: string
  /** 本次 redo 登记的 operation（applying 状态）。 */
  operationId: string
  restoredPaths: string[]
  /** 重做失败的单路径清单（含原因），随 operation.error 与 notice 持久化。 */
  notRestored: { path: string, reason: string }[]
  createdAt: string
}

/**
 * 完成一次 redo 的唯一入口：单事务内校验并落旧 operation/turn/新 operation/notice。
 *
 * - 旧 undo operation 只能从 applied → redone，turn 只能从 undone → settled，
 *   任一 UPDATE 命中数 !== 1 即状态漂移：事务回滚且本次 redo operation 落
 *   needs-recovery，交给启动围栏拦截该 workspace（与 undo 路径对等，P0-4）；
 * - 未恢复路径写入 operation.error 与 notice，部分重做同样留下持久审计。
 */
export function completeRedoTransaction(db: Ledger, completion: RedoCompletion): 'settled' | 'needs-recovery' {
  const summary = completion.notRestored.length > 0
    ? completion.notRestored.map(entry => `${entry.path} (${entry.reason})`).join('; ')
    : null
  db.exec('BEGIN IMMEDIATE')
  try {
    const previous = db.prepare(`
      UPDATE operations SET outcome = 'redone', settled_at = ?
      WHERE operation_id = ? AND kind = 'undo' AND outcome = 'applied'
    `).run(new Date().toISOString(), completion.redoneOperationId)
    if (previous.changes !== 1)
      throw new Error(`OPERATION_STATE_MISMATCH: undo operation ${completion.redoneOperationId} is no longer applied`)
    const turn = db.prepare(`
      UPDATE turns SET status = 'settled', reversible = 1, settled_at = ?
      WHERE turn_id = ? AND status = 'undone'
    `).run(new Date().toISOString(), completion.targetTurnId)
    if (turn.changes !== 1)
      throw new Error(`TURN_STATE_MISMATCH: turn ${completion.targetTurnId} is not undone`)
    const operation = db.prepare(`
      UPDATE operations SET outcome = 'applied', settled_at = ?, error = ?
      WHERE operation_id = ? AND outcome = 'applying'
    `).run(new Date().toISOString(), summary, completion.operationId)
    if (operation.changes !== 1)
      throw new Error(`OPERATION_STATE_MISMATCH: operation ${completion.operationId} is not applying`)
    db.prepare(`
      INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, status, created_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'redo')
    `).run(
      completion.noticeId,
      completion.sessionId,
      completion.workspaceKey,
      completion.targetTurnId,
      JSON.stringify([completion.targetTurnId]),
      JSON.stringify(capNoticePaths([...completion.restoredPaths, ...completion.notRestored.map(entry => entry.path)])),
      completion.createdAt,
    )
    db.exec('COMMIT')
    return 'settled'
  }
  catch (error) {
    db.exec('ROLLBACK')
    // 账本未能完成：redo operation 落 needs-recovery，启动围栏将拦截该 workspace
    db.prepare(`
      UPDATE operations SET outcome = 'needs-recovery', settled_at = ?, error = ?
      WHERE operation_id = ? AND outcome = 'applying'
    `).run(new Date().toISOString(), String((error as Error).message), completion.operationId)
    throw error
  }
}
