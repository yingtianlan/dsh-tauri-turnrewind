import { S as MAX_FILE_BYTES, _ as workspaceHash, c as gitRef, d as restorePath, g as stateAt, h as snapshotFileDiff, i as currentState, l as probeWorkspace, m as snapshotDiff, n as classifyPathChange, t as captureSnapshot, v as workspaceKey, w as PENDING_PLAN_TTL_MS } from "./git-snapshot-zS8H1aWQ.js";
import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import process from "node:process";
import { dirname, join, parse, resolve } from "pathe";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

//#region src/host/service/ledger.ts
/**
* host/service/ledger.ts — SQLite 账本（turns / operations / notices / pending plans）。
*
* WAL 模式；所有多写点变更走单事务（BEGIN/COMMIT）。turn 生命周期、undo 计划、
* 一次性提示与恢复围栏（needs-recovery）的持久状态都住在这里。
*/
/** 账本备份间隔（24h）：ledger.sqlite.bak 是损坏时的唯一自愈来源。 */
const LEDGER_BACKUP_INTERVAL_MS = 1440 * 60 * 1e3;
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
`;
/**
* 滚动备份：VACUUM INTO 输出一致性快照（WAL 下亦然），写 .pending 后原子
* 改名，失败不阻断打开（openLedger 无 logger 注入，console.warn 兜底一行）。
* 独立导出：测试可强制补拍（TTL 内的二次备份默认跳过）。
*/
function backupLedger(db, dbPath, { force = false } = {}) {
	const backupPath = `${dbPath}.bak`;
	try {
		const stat = statSync(backupPath, { throwIfNoEntry: false });
		if (!force && stat && Date.now() - stat.mtimeMs < LEDGER_BACKUP_INTERVAL_MS) return;
		const pending = `${backupPath}.pending`;
		rmSync(pending, { force: true });
		db.exec(`VACUUM INTO '${pending.replaceAll("'", "''")}'`);
		rmSync(backupPath, { force: true });
		renameSync(pending, backupPath);
	} catch (error) {
		console.warn(`turnrewind: ledger backup failed (continuing): ${String(error)}`);
	}
}
function openLedger(rootDir) {
	const path = join(rootDir, "ledger.sqlite");
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA busy_timeout = 5000");
	let check;
	try {
		check = db.prepare("PRAGMA quick_check(1)").get();
	} catch (error) {
		db.close();
		throw new Error(`TURNREWIND_LEDGER_CORRUPT: ${path}: ${error.message}`);
	}
	if (check?.quick_check !== "ok") {
		db.close();
		throw new Error(`TURNREWIND_LEDGER_CORRUPT: ${path}: ${check?.quick_check ?? "unreadable"} — restore ledger.sqlite.bak or clear the data dir`);
	}
	db.exec(SCHEMA);
	for (const migration of [
		"ALTER TABLE operations ADD COLUMN after_ref TEXT",
		"ALTER TABLE rewind_notices ADD COLUMN turns_json TEXT NOT NULL DEFAULT '[]'",
		"ALTER TABLE rewind_notices ADD COLUMN kind TEXT NOT NULL DEFAULT 'rewind'",
		"ALTER TABLE rewind_notices ADD COLUMN reason TEXT",
		"ALTER TABLE pending_plans ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
		"ALTER TABLE pending_plans ADD COLUMN result_text TEXT",
		"ALTER TABLE pending_plans ADD COLUMN before_ref TEXT",
		"ALTER TABLE pending_plans ADD COLUMN after_ref TEXT",
		"ALTER TABLE pending_plans ADD COLUMN paths_digest TEXT"
	]) try {
		db.exec(migration);
	} catch {}
	db.exec(`UPDATE turns SET status = 'abandoned', reversible = 0, error = 'plugin restarted during active turn' WHERE status = 'active'`);
	db.prepare(`UPDATE operations SET outcome = 'needs-recovery', settled_at = COALESCE(settled_at, ?), error = 'plugin restarted while the operation was applying; workspace recovery is required' WHERE outcome = 'applying'`).run((/* @__PURE__ */ new Date()).toISOString());
	db.prepare(`
    UPDATE pending_plans SET status = 'applied',
      result_text = COALESCE(result_text, 'host restarted while this plan was applying; the undo was applied')
    WHERE status = 'applying'
      AND EXISTS (SELECT 1 FROM turns WHERE turns.turn_id = pending_plans.turn_id AND turns.status = 'undone')
  `).run();
	db.prepare(`UPDATE pending_plans SET status = 'expired', result_text = COALESCE(result_text, 'host restarted while this plan was applying') WHERE status = 'applying'`).run();
	prunePendingPlans(db);
	backupLedger(db, path);
	return db;
}
/**
* 失效 plan 清扫：过期的 pending 行转为 `expired` 永久留档，不删除。
*
* 过期只锁执行（confirm 路径按状态拒绝），不抹掉审计记录：卡片里的文件
* 清单与 diff 来自命令输出文本（对话内永久存在），plan 行保留后状态轮询
* 返回 expired，用户随时可以回看「当时预览了什么」。settled 行
* （applied/cancelled）同样永远保留。
*/
function prunePendingPlans(db) {
	db.prepare("UPDATE pending_plans SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run((/* @__PURE__ */ new Date()).toISOString());
}
function registerWorkspace(db, workspaceKey$1, workspacePath, snapshotRepo) {
	db.prepare(`
    INSERT INTO workspaces(workspace_key, workspace_path, snapshot_repo, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_key) DO UPDATE SET workspace_path = excluded.workspace_path, snapshot_repo = excluded.snapshot_repo
  `).run(workspaceKey$1, workspacePath, snapshotRepo, (/* @__PURE__ */ new Date()).toISOString());
}
function insertTurn(db, turn) {
	db.prepare(`
    INSERT INTO turns(turn_id, session_id, workspace_key, status, started_at, before_ref)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(turn.turnId, turn.sessionId, turn.workspaceKey, turn.startedAt, turn.beforeRef ?? null);
}
function getTurn(db, turnId) {
	return db.prepare("SELECT * FROM turns WHERE turn_id = ?").get(turnId);
}
function getLatestSnapshotRef(db, workspaceKey$1) {
	return db.prepare(`
    SELECT after_ref FROM turns
    WHERE workspace_key = ? AND after_ref IS NOT NULL
    ORDER BY settled_at DESC LIMIT 1
  `).get(workspaceKey$1)?.after_ref;
}
function createOperation(db, operation) {
	db.prepare(`
    INSERT INTO operations(operation_id, kind, target_turn_id, requested_at, outcome, before_ref)
    VALUES (?, ?, ?, ?, 'applying', ?)
  `).run(operation.operationId, operation.kind, operation.targetTurnId, operation.requestedAt, operation.beforeRef ?? null);
}
function settleOperation(db, operationId, outcome, error) {
	db.prepare("UPDATE operations SET settled_at = ?, outcome = ?, error = ? WHERE operation_id = ?").run((/* @__PURE__ */ new Date()).toISOString(), outcome, error ? String(error) : null, operationId);
}
function claimRewindNotices(db, sessionId, workspaceKey$1) {
	const claimedAt = (/* @__PURE__ */ new Date()).toISOString();
	db.exec("BEGIN IMMEDIATE");
	try {
		const notices = db.prepare(`
      SELECT * FROM rewind_notices
      WHERE session_id = ? AND workspace_key = ? AND status = 'pending'
      ORDER BY created_at ASC
    `).all(sessionId, workspaceKey$1);
		if (notices.length === 0) {
			db.exec("COMMIT");
			return [];
		}
		const statement = db.prepare(`
      UPDATE rewind_notices SET status = 'consumed', claimed_at = ?
      WHERE notice_id = ? AND status = 'pending'
    `);
		for (const notice of notices) statement.run(claimedAt, notice.notice_id);
		db.exec("COMMIT");
		return notices.map((notice) => ({
			...notice,
			paths: JSON.parse(notice.paths_json),
			turns: JSON.parse(notice.turns_json || "[]")
		}));
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}
/**
* 敏感文件提醒的去重查询：每会话+工作区只发一条（kind 'sensitive-files'）。
* 独立导出：baselineTask 用它避免每 turn 都跑扫描。
*/
function hasSensitiveNotice(db, sessionId, workspaceKey$1) {
	return db.prepare(`
    SELECT 1 FROM rewind_notices
    WHERE session_id = ? AND workspace_key = ? AND kind = 'sensitive-files'
    LIMIT 1
  `).get(sessionId, workspaceKey$1) !== void 0;
}
/** 写入敏感文件提醒（kind 'sensitive-files'，reason 携带文件清单）；重复为 no-op。 */
function queueSensitiveNotice(db, sessionId, workspaceKey$1, files) {
	db.exec("BEGIN IMMEDIATE");
	try {
		if (hasSensitiveNotice(db, sessionId, workspaceKey$1)) {
			db.exec("COMMIT");
			return false;
		}
		db.prepare(`
      INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, kind, reason, status, created_at)
      VALUES (?, ?, ?, 'workspace-sensitive', '[]', ?, 'sensitive-files', ?, 'pending', ?)
    `).run(randomUUID(), sessionId, workspaceKey$1, JSON.stringify(capNoticePaths(files)), files.join("; "), (/* @__PURE__ */ new Date()).toISOString());
		db.exec("COMMIT");
		return true;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}
/** 恢复面板数据源：按 workspace 分组的围栏明细（供 UI 与 recover 路由）。 */
function listRecoveryWorkspaces(db) {
	const rows = db.prepare(`
    SELECT o.operation_id AS operation_id, o.kind AS kind, o.target_turn_id AS target_turn_id,
           o.requested_at AS requested_at, o.settled_at AS settled_at, o.error AS error,
           t.workspace_key AS workspace_key, w.workspace_path AS workspace_path
    FROM operations o
    JOIN turns t ON t.turn_id = o.target_turn_id
    LEFT JOIN workspaces w ON w.workspace_key = t.workspace_key
    WHERE o.outcome = 'needs-recovery'
    ORDER BY COALESCE(o.settled_at, o.requested_at) DESC
  `).all();
	const byWorkspace = /* @__PURE__ */ new Map();
	for (const row of rows) {
		let entry = byWorkspace.get(row.workspace_key);
		if (!entry) {
			entry = {
				workspace_key: row.workspace_key,
				workspace_path: row.workspace_path,
				operations: []
			};
			byWorkspace.set(row.workspace_key, entry);
		}
		entry.operations.push({
			operation_id: row.operation_id,
			kind: row.kind,
			target_turn_id: row.target_turn_id,
			requested_at: row.requested_at,
			settled_at: row.settled_at,
			error: row.error
		});
	}
	return [...byWorkspace.values()];
}
/**
* 用户确认「已人工检查该 workspace」后解除恢复围栏：该 workspace 的全部
* needs-recovery 操作转为 recovery-acknowledged 终态。账本行保留审计；
* 围栏查询只认 needs-recovery，改写即解锁，重启清扫也不再触碰（它只扫
* applying）。返回改写行数。
*/
function acknowledgeRecovery(db, workspaceKey$1) {
	return Number(db.prepare(`
    UPDATE operations SET outcome = 'recovery-acknowledged',
      error = COALESCE(error, '') || ' [recovery acknowledged at ' || ? || ']'
    WHERE outcome = 'needs-recovery'
      AND target_turn_id IN (SELECT turn_id FROM turns WHERE workspace_key = ?)
  `).run((/* @__PURE__ */ new Date()).toISOString(), workspaceKey$1).changes);
}
/**
* P1-6：实时围栏查询。needs-recovery 可能发生在任意时刻（账本事务失败的
* catch 路径），启动时加载的内存集合会过期——围栏判定一律查库。
*/
function hasNeedsRecoveryWorkspace(db, workspaceKey$1) {
	return db.prepare(`
    SELECT 1
    FROM operations o
    JOIN turns t ON t.turn_id = o.target_turn_id
    WHERE o.outcome = 'needs-recovery' AND t.workspace_key = ?
    LIMIT 1
  `).get(workspaceKey$1) !== void 0;
}
/** 预览路径集的稳定摘要：排序后 sha256。confirm 时校验计划是否漂移（P1-2）。 */
function planPathsDigest(paths) {
	return createHash("sha256").update([...paths].sort().join("\0")).digest("hex");
}
function createPendingPlan(db, plan) {
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare("UPDATE pending_plans SET status = 'expired' WHERE session_id = ? AND workspace_key = ? AND status = 'pending'").run(plan.sessionId, plan.workspaceKey);
		const planId = randomUUID();
		const createdAt = (/* @__PURE__ */ new Date()).toISOString();
		db.prepare(`
      INSERT INTO pending_plans(plan_id, session_id, workspace_key, turn_id, paths_json, before_ref, after_ref, paths_digest, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(planId, plan.sessionId, plan.workspaceKey, plan.turnId, JSON.stringify(plan.paths), plan.beforeRef, plan.afterRef, planPathsDigest(plan.paths), createdAt, new Date(Date.now() + PENDING_PLAN_TTL_MS).toISOString());
		db.exec("COMMIT");
		return planId;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}
/**
* Atomically move one pending plan to `applying` so concurrent confirm/cancel
* calls cannot interleave: the conditional UPDATE is serialized by SQLite, so
* exactly one caller sees changes === 1 and everyone else gets a deterministic
* failure. The pre-reads only pick a precise error code; the UPDATE decides.
*/
function claimPendingPlan(db, planId, sessionId) {
	const row = db.prepare("SELECT * FROM pending_plans WHERE plan_id = ?").get(planId);
	if (row === void 0) return {
		ok: false,
		code: 404,
		error: "plan not found — run /undo again"
	};
	if (row.session_id !== sessionId) return {
		ok: false,
		code: 403,
		error: "the plan belongs to another session"
	};
	if (row.status === "expired") return {
		ok: false,
		code: 410,
		error: "this plan has expired — run /undo again to preview a fresh plan"
	};
	if (row.status !== "pending") return {
		ok: false,
		code: 409,
		error: "this plan was already applied, cancelled, or is being applied — run /undo again"
	};
	if (row.expires_at < (/* @__PURE__ */ new Date()).toISOString()) {
		db.prepare("UPDATE pending_plans SET status = 'expired' WHERE plan_id = ? AND status = 'pending'").run(planId);
		return {
			ok: false,
			code: 410,
			error: "this plan has expired — run /undo again to preview a fresh plan"
		};
	}
	if (db.prepare(`
    UPDATE pending_plans SET status = 'applying'
    WHERE plan_id = ? AND session_id = ? AND status = 'pending'
  `).run(planId, sessionId).changes !== 1) return {
		ok: false,
		code: 409,
		error: "this plan was already applied, cancelled, or is being applied — run /undo again"
	};
	return {
		ok: true,
		row: {
			...row,
			paths: JSON.parse(row.paths_json)
		}
	};
}
/** Return an in-flight claim to `pending` after a failed confirm attempt. */
function releasePendingPlanClaim(db, planId) {
	db.prepare(`
    UPDATE pending_plans SET status = 'pending'
    WHERE plan_id = ? AND status = 'applying'
  `).run(planId);
}
/**
* Plan lookup for the confirm HTTP route: keyed by plan id only — the client
* does not know the workspace key, the row itself carries it (and the owner
* session, which the route re-checks against the caller).
*/
function getPendingPlanRow(db, planId) {
	const row = db.prepare("SELECT * FROM pending_plans WHERE plan_id = ?").get(planId);
	if (row === void 0) return void 0;
	if (row.status === "pending" && row.expires_at < (/* @__PURE__ */ new Date()).toISOString()) {
		db.prepare("UPDATE pending_plans SET status = 'expired' WHERE plan_id = ? AND status = 'pending'").run(planId);
		row.status = "expired";
	}
	return {
		...row,
		paths: JSON.parse(row.paths_json)
	};
}
/** Dismissal from the ✕ button: workspace key is unknown client-side. */
function markPendingPlanCancelled(db, planId, sessionId) {
	return db.prepare(`
    UPDATE pending_plans SET status = 'cancelled'
    WHERE plan_id = ? AND session_id = ? AND status = 'pending'
  `).run(planId, sessionId).changes > 0;
}
/** Outcome written by the confirm route so the client card can poll it. Only a claimed (`applying`) plan can be applied. */
function markPendingPlanApplied(db, planId, sessionId, message) {
	db.prepare(`
    UPDATE pending_plans SET status = 'applied', result_text = ?
    WHERE plan_id = ? AND session_id = ? AND status = 'applying'
  `).run(message, planId, sessionId);
}
function getPendingPlanStatus(db, planId, sessionId) {
	const row = db.prepare("SELECT plan_id, status, result_text, expires_at FROM pending_plans WHERE plan_id = ? AND session_id = ?").get(planId, sessionId);
	if (row === void 0) return void 0;
	if (row.status === "pending" && row.expires_at < (/* @__PURE__ */ new Date()).toISOString()) {
		db.prepare("UPDATE pending_plans SET status = 'expired' WHERE plan_id = ? AND status = 'pending'").run(row.plan_id);
		row.status = "expired";
	}
	return {
		status: row.status,
		resultText: row.result_text
	};
}
function settleTurn(db, turnId, afterRef) {
	db.prepare("UPDATE turns SET status = 'settled', settled_at = ?, after_ref = ?, reversible = 1 WHERE turn_id = ?").run((/* @__PURE__ */ new Date()).toISOString(), afterRef, turnId);
}
function settleNoopTurn(db, turnId, afterRef) {
	db.prepare("UPDATE turns SET status = 'settled', settled_at = ?, after_ref = ?, reversible = 0, error = 'no file changes' WHERE turn_id = ?").run((/* @__PURE__ */ new Date()).toISOString(), afterRef, turnId);
}
function settleInterruptedTurn(db, turnId, afterRef, reason) {
	db.prepare("UPDATE turns SET status = 'interrupted', settled_at = ?, after_ref = ?, reversible = 1, error = ? WHERE turn_id = ?").run((/* @__PURE__ */ new Date()).toISOString(), afterRef, reason, turnId);
}
function failTurn(db, turnId, error) {
	db.prepare("UPDATE turns SET status = 'failed', settled_at = ?, reversible = 0, error = ? WHERE turn_id = ?").run((/* @__PURE__ */ new Date()).toISOString(), String(error), turnId);
}
function skipTurn(db, turn, reason) {
	db.prepare(`
    INSERT INTO turns(turn_id, session_id, workspace_key, status, started_at, settled_at, reversible, error)
    VALUES (?, ?, ?, 'skipped', ?, ?, 0, ?)
  `).run(turn.turnId, turn.sessionId, turn.workspaceKey, turn.startedAt, (/* @__PURE__ */ new Date()).toISOString(), reason);
}
/** skipped turn + 每会话/工作区一次性 heads-up（去重由 rewind_notices 承担）。 */
function recordSkippedTurn(db, turn, reason) {
	db.exec("BEGIN IMMEDIATE");
	try {
		skipTurn(db, turn, reason);
		if (!db.prepare(`
      SELECT 1 FROM rewind_notices WHERE session_id = ? AND workspace_key = ? AND kind = 'unsupported' LIMIT 1
    `).get(turn.sessionId, turn.workspaceKey)) db.prepare(`
        INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, kind, reason, status, created_at)
        VALUES (?, ?, ?, 'workspace-unsupported', '[]', '[]', 'unsupported', ?, 'pending', ?)
      `).run(randomUUID(), turn.sessionId, turn.workspaceKey, reason, (/* @__PURE__ */ new Date()).toISOString());
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}
function markTurnSnapshotMissing(db, turnId) {
	db.prepare("UPDATE turns SET reversible = 0, error = 'snapshot ref missing (snapshot repository was wiped)' WHERE turn_id = ?").run(turnId);
}
function listReversibleTurns(db, sessionId, workspaceKey$1) {
	return db.prepare(`
    SELECT * FROM turns
    WHERE session_id = ? AND workspace_key = ? AND reversible = 1 AND status IN ('settled', 'interrupted')
    ORDER BY started_at DESC
  `).all(sessionId, workspaceKey$1);
}
function getLatestTurnSummary(db, sessionId, workspaceKey$1) {
	if (workspaceKey$1 === void 0) return db.prepare(`
      SELECT turn_id, workspace_key, status, reversible, settled_at
      FROM turns WHERE session_id = ? ORDER BY started_at DESC LIMIT 1
    `).get(sessionId);
	return db.prepare(`
    SELECT turn_id, workspace_key, status, reversible, settled_at
    FROM turns WHERE session_id = ? AND workspace_key = ? ORDER BY started_at DESC LIMIT 1
  `).get(sessionId, workspaceKey$1);
}
function getLatestAppliedUndo(db, sessionId, workspaceKey$1) {
	return db.prepare(`
    SELECT * FROM operations
    WHERE kind = 'undo' AND outcome = 'applied'
      AND target_turn_id IN (SELECT turn_id FROM turns WHERE session_id = ? AND workspace_key = ?)
    ORDER BY settled_at DESC LIMIT 1
  `).get(sessionId, workspaceKey$1);
}
/** 消费超过 7 天的 notice 行删除；pending 与近期行保留（弹窗去重语义）。 */
function pruneConsumedNotices(db, maxAgeMs = 10080 * 60 * 1e3) {
	const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
	return Number(db.prepare("DELETE FROM rewind_notices WHERE status = 'consumed' AND claimed_at < ?").run(cutoff).changes);
}
/** notice 路径清单上限（P1-4）：超出部分以摘要行代替，防账本行与模型上下文膨胀。 */
const MAX_NOTICE_PATHS = 500;
function capNoticePaths(paths) {
	return paths.length > MAX_NOTICE_PATHS ? [...paths.slice(0, MAX_NOTICE_PATHS), `…and ${paths.length - MAX_NOTICE_PATHS} more path(s)`] : paths;
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
function completeUndoTransaction(db, completion) {
	const summary = completion.notRestored.length > 0 ? completion.notRestored.map((entry) => `${entry.path} (${entry.reason})`).join("; ") : null;
	db.exec("BEGIN IMMEDIATE");
	try {
		if (db.prepare(`
      UPDATE turns SET status = 'undone', settled_at = ?
      WHERE turn_id = ? AND status IN ('settled', 'interrupted') AND reversible = 1
    `).run((/* @__PURE__ */ new Date()).toISOString(), completion.targetTurnId).changes !== 1) throw new Error(`TURN_STATE_MISMATCH: turn ${completion.targetTurnId} is not in a restorable state`);
		if (db.prepare(`
      UPDATE operations SET outcome = 'applied', settled_at = ?, error = ?
      WHERE operation_id = ? AND outcome = 'applying'
    `).run((/* @__PURE__ */ new Date()).toISOString(), summary, completion.operationId).changes !== 1) throw new Error(`OPERATION_STATE_MISMATCH: operation ${completion.operationId} is not applying`);
		db.prepare(`
      INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, status, created_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'undo')
    `).run(completion.noticeId, completion.sessionId, completion.workspaceKey, completion.targetTurnId, JSON.stringify([completion.targetTurnId]), JSON.stringify(capNoticePaths([...completion.restoredPaths, ...completion.notRestored.map((entry) => entry.path)])), completion.createdAt);
		db.exec("COMMIT");
		return "undone";
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		db.prepare(`
      UPDATE operations SET outcome = 'needs-recovery', settled_at = ?, error = ?
      WHERE operation_id = ? AND outcome = 'applying'
    `).run((/* @__PURE__ */ new Date()).toISOString(), String(error.message), completion.operationId);
		throw error;
	}
}
/**
* 完成一次 redo 的唯一入口：单事务内校验并落旧 operation/turn/新 operation/notice。
*
* - 旧 undo operation 只能从 applied → redone，turn 只能从 undone → settled，
*   任一 UPDATE 命中数 !== 1 即状态漂移：事务回滚且本次 redo operation 落
*   needs-recovery，交给启动围栏拦截该 workspace（与 undo 路径对等，P0-4）；
* - 未恢复路径写入 operation.error 与 notice，部分重做同样留下持久审计。
*/
function completeRedoTransaction(db, completion) {
	const summary = completion.notRestored.length > 0 ? completion.notRestored.map((entry) => `${entry.path} (${entry.reason})`).join("; ") : null;
	db.exec("BEGIN IMMEDIATE");
	try {
		if (db.prepare(`
      UPDATE operations SET outcome = 'redone', settled_at = ?
      WHERE operation_id = ? AND kind = 'undo' AND outcome = 'applied'
    `).run((/* @__PURE__ */ new Date()).toISOString(), completion.redoneOperationId).changes !== 1) throw new Error(`OPERATION_STATE_MISMATCH: undo operation ${completion.redoneOperationId} is no longer applied`);
		if (db.prepare(`
      UPDATE turns SET status = 'settled', reversible = 1, settled_at = ?
      WHERE turn_id = ? AND status = 'undone'
    `).run((/* @__PURE__ */ new Date()).toISOString(), completion.targetTurnId).changes !== 1) throw new Error(`TURN_STATE_MISMATCH: turn ${completion.targetTurnId} is not undone`);
		if (db.prepare(`
      UPDATE operations SET outcome = 'applied', settled_at = ?, error = ?
      WHERE operation_id = ? AND outcome = 'applying'
    `).run((/* @__PURE__ */ new Date()).toISOString(), summary, completion.operationId).changes !== 1) throw new Error(`OPERATION_STATE_MISMATCH: operation ${completion.operationId} is not applying`);
		db.prepare(`
      INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, status, created_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'redo')
    `).run(completion.noticeId, completion.sessionId, completion.workspaceKey, completion.targetTurnId, JSON.stringify([completion.targetTurnId]), JSON.stringify(capNoticePaths([...completion.restoredPaths, ...completion.notRestored.map((entry) => entry.path)])), completion.createdAt);
		db.exec("COMMIT");
		return "settled";
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		db.prepare(`
      UPDATE operations SET outcome = 'needs-recovery', settled_at = ?, error = ?
      WHERE operation_id = ? AND outcome = 'applying'
    `).run((/* @__PURE__ */ new Date()).toISOString(), String(error.message), completion.operationId);
		throw error;
	}
}

//#endregion
//#region src/host/service/guard.ts
/**
* host/service/guard.ts — 系统目录工作区拒绝（家目录/祖先/盘根）。
*
* Git 目录模式不再做全目录预算扫描：Git ignore 语义决定快照面，本守卫只保留
* 「绝不可快照」的系统目录判定。pathe 输出正斜杠而宿主 cwd 可能带反斜杠，
* 比较前统一归一化分隔符；pathe 对「已绝对的盘根」（resolve('C:/') → '/C:'）
* 有怪输出，normalize 前先把裸盘符恢复成盘根形态。
*/
const BACKSLASH = String.fromCharCode(92);
function normalizeDir(path) {
	const raw = resolve(path);
	const corrected = process.platform === "win32" && /^\/[a-z]:$/i.test(raw) ? `${raw.slice(1)}/` : raw;
	try {
		const fsPath = process.platform === "win32" ? corrected.replaceAll("/", BACKSLASH) : corrected;
		return realpathSync.native(fsPath);
	} catch {
		return corrected;
	}
}
function foldCase(path) {
	return (process.platform === "win32" ? path.toLowerCase() : path).replaceAll(BACKSLASH, "/");
}
function isSystemSensitiveWorkspace(workspaceDir) {
	const workspace = foldCase(normalizeDir(workspaceDir));
	if (workspace.startsWith("//")) {
		if (workspace.split("/").filter(Boolean).length <= 2) return true;
	}
	const home = foldCase(normalizeDir(homedir()));
	if (workspace === home) return true;
	if (home.startsWith(`${workspace}/`)) return true;
	return foldCase(parse(workspace).root) === workspace;
}

//#endregion
//#region src/host/service/planner.ts
function classifyUndo(current, expected) {
	if (current.kind !== expected.kind) return "conflict";
	if (current.digest !== expected.digest) return "conflict";
	return "safe";
}
/**
* 计划漂移校验（P1-2）：确认时的 turn 快照 ref 与重算 diff 必须与预览一致，
* 即「确认的就是预览时看到的」。绑定列为 NULL 的旧格式 plan（无从校验）
* 从严处理：一律按漂移拒绝并要求重新预览——宁可多看一次预览，
* 不可在不可验证的计划上执行恢复。
*/
function planDrift(plan, target, currentPaths) {
	if (plan.before_ref === null || plan.after_ref === null || plan.paths_digest === null) return "the plan predates preview binding and cannot be verified";
	if (target.before_ref !== plan.before_ref || target.after_ref !== plan.after_ref) return "the turn snapshots no longer match the preview";
	if (planPathsDigest(currentPaths) !== plan.paths_digest) return "the change set no longer matches the preview";
}

//#endregion
//#region src/host/service/workspace-lock.ts
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
/** 持锁进程挂死（pid 仍被占用）时的接管兜底预算。 */
const LOCK_STALE_TTL_MS = 1800 * 1e3;
/** 忙等重试间隔与总尝试上限（100 次 × 100ms ≈ 10s 等待 + 接管竞态余量）。 */
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_MAX_ATTEMPTS = 200;
var WorkspaceLockBusyError = class extends Error {
	constructor(workspaceDir, holder) {
		super(`TURNREWIND_LOCK_BUSY: ${workspaceDir} is locked by another process${holder ? ` (pid ${holder.pid})` : ""}`);
		this.name = "WorkspaceLockBusyError";
	}
};
function lockPathFor(rootDir, workspaceDir) {
	return join(rootDir, "locks", `${workspaceHash(workspaceDir)}.lock`);
}
function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "EPERM") return true;
		return false;
	}
}
function readLockContent(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed.pid === "number" && typeof parsed.token === "string" && typeof parsed.acquiredAt === "string") return parsed;
		return;
	} catch {
		return;
	}
}
function isStale(content) {
	if (!content) return true;
	if (!pidAlive(content.pid)) return true;
	return Date.now() - Date.parse(content.acquiredAt) > LOCK_STALE_TTL_MS;
}
function writeLockFile(path, token) {
	const payload = {
		pid: process.pid,
		token,
		acquiredAt: (/* @__PURE__ */ new Date()).toISOString(),
		host: hostname()
	};
	const fd = openSync(path, "wx");
	try {
		writeFileSync(fd, JSON.stringify(payload));
	} finally {
		closeSync(fd);
	}
}
function releaseLockFile(path, token) {
	if (readLockContent(path)?.token === token) rmSync(path, { force: true });
}
/** 异步获取：waitMs 内按 100ms 步长忙等；超时或竞态余量耗尽抛 WorkspaceLockBusyError。 */
async function acquireWorkspaceLock(rootDir, workspaceDir, { waitMs = 0 } = {}) {
	const path = lockPathFor(rootDir, workspaceDir);
	mkdirSync(dirname(path), { recursive: true });
	const token = randomUUID();
	const deadline = Date.now() + waitMs;
	for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) try {
		writeLockFile(path, token);
		if (readLockContent(path)?.token !== token) {
			releaseLockFile(path, token);
			continue;
		}
		let released = false;
		return { release() {
			if (released) return;
			released = true;
			releaseLockFile(path, token);
		} };
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		const holder = readLockContent(path);
		if (!isStale(holder)) {
			if (holder && Date.now() < deadline) {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_DELAY_MS));
				continue;
			}
			throw new WorkspaceLockBusyError(workspaceDir, holder);
		}
		rmSync(path, { force: true });
	}
	throw new WorkspaceLockBusyError(workspaceDir, readLockContent(path));
}
/** 同步获取（purge CLI 等 offline 工具）：只尝试一次，忙即抛错。 */
function acquireWorkspaceLockSync(rootDir, workspaceDir) {
	const path = lockPathFor(rootDir, workspaceDir);
	if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
	const token = randomUUID();
	try {
		writeLockFile(path, token);
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		throw new WorkspaceLockBusyError(workspaceDir, readLockContent(path));
	}
	if (readLockContent(path)?.token !== token) {
		releaseLockFile(path, token);
		throw new WorkspaceLockBusyError(workspaceDir, readLockContent(path));
	}
	let released = false;
	return { release() {
		if (released) return;
		released = true;
		releaseLockFile(path, token);
	} };
}
/** 在 workspace 锁内执行异步工作：获取失败抛 WorkspaceLockBusyError，成功后保证释放。 */
async function withWorkspaceLock(rootDir, workspaceDir, work, { waitMs = 0 } = {}) {
	const handle = await acquireWorkspaceLock(rootDir, workspaceDir, { waitMs });
	try {
		return await work();
	} finally {
		handle.release();
	}
}

//#endregion
//#region src/host/service/undo.ts
/**
* applyUndo — /undo 命令入口（两阶段流：预览卡 → --confirm 执行）。
*
* 依赖 workspaceForAgent/workspaceIssue/workspaceKeyFor（宿主装配层的判定），
* 经 WorkspaceEnv 注入保持本文件可独立单测。
*/
async function applyRedo(runtime, invocation, workspaceDir, workspaceKey$1) {
	const op = getLatestAppliedUndo(runtime.db, invocation.agent.session.id, workspaceKey$1);
	if (!op) return {
		kind: "error",
		text: "No previously applied undo is available to redo."
	};
	const turn = getTurn(runtime.db, op.target_turn_id);
	if (!turn || !turn.before_ref || !turn.after_ref) return {
		kind: "error",
		text: "The undone turn no longer has a recoverable snapshot."
	};
	if (!await turnRefsExist(runtime.store, turn)) return {
		kind: "error",
		text: "The snapshot data for the undone turn no longer exists (the snapshot repository was previously wiped)."
	};
	const paths = await snapshotDiff(runtime.store, turn.before_ref, turn.after_ref);
	if (paths.length === 0) return {
		kind: "success",
		text: "No file changes were recorded for this turn."
	};
	const conflicts = [];
	for (const path of paths) {
		const expected = await stateAt(runtime.store, turn.before_ref, path);
		if (classifyUndo(await currentState(workspaceDir, path), expected) === "conflict") conflicts.push(path);
	}
	if (conflicts.length > 0) {
		const lines = [];
		lines.push(`Redo is blocked: ${conflicts.length} conflicted file(s) were edited after the undo.`);
		lines.push("");
		lines.push("Conflicts (undone state → current disk; redo would overwrite these changes):");
		for (const path of conflicts) {
			const diff = await safeDiffAgainstDisk(runtime.store, turn.before_ref, path);
			lines.push(`--- ${path}`);
			lines.push(diff ? indent(diff, "  ") : "  (no textual diff)");
		}
		return {
			kind: "error",
			text: lines.join("\n")
		};
	}
	runtime.undoing = true;
	try {
		const lock = await acquireWorkspaceLock(runtime.store.rootDir, runtime.workspaceDir, { waitMs: 1e4 });
		try {
			const operationId = randomUUID();
			const beforeRef = `refs/turnrewind/redo-${operationId}`;
			await captureSnapshot(runtime.store, beforeRef, `turnrewind redo ${turn.turn_id}`, runtime.parentRef);
			createOperation(runtime.db, {
				operationId,
				kind: "redo",
				targetTurnId: turn.turn_id,
				requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
				beforeRef
			});
			const restoredPaths = [];
			const failedPaths = [];
			for (const path of paths) try {
				await restorePath(runtime.store, turn.after_ref, path);
				restoredPaths.push(path);
			} catch (error) {
				failedPaths.push({
					path,
					reason: String(error.message ?? error)
				});
			}
			completeRedoTransaction(runtime.db, {
				noticeId: randomUUID(),
				sessionId: invocation.agent.session.id,
				workspaceKey: workspaceKey$1,
				targetTurnId: turn.turn_id,
				redoneOperationId: op.operation_id,
				operationId,
				restoredPaths,
				notRestored: failedPaths,
				createdAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			runtime.parentRef = beforeRef;
			let text = `re-applied ${restoredPaths.length} file(s). The next model request will receive a rewind notice.`;
			if (failedPaths.length > 0) text += ` Not restored (${failedPaths.length} file(s)): ${failedPaths.map((failure) => `${failure.path} (${failure.reason.includes("TURNREWIND_FILE_TOO_LARGE") ? "over the size limit" : failure.reason})`).join("; ")}.`;
			return {
				kind: "success",
				text
			};
		} finally {
			lock.release();
		}
	} catch (error) {
		return {
			kind: "error",
			text: String(error?.message ?? error)
		};
	} finally {
		runtime.undoing = false;
	}
}
function workspaceForSession(session) {
	const cwd = session?.header?.cwd;
	if (typeof cwd !== "string" || cwd.length === 0) return void 0;
	const resolved = resolve(cwd);
	if (isSystemSensitiveWorkspace(resolved)) return void 0;
	const probe = probeWorkspace(resolved);
	return probe.ok ? probe.workspaceDir : void 0;
}
function workspaceForAgent(agent) {
	return workspaceForSession(agent?.session);
}
function workspaceKeyFor(path) {
	return workspaceKey(path);
}
function workspaceIssue(workspaceDir) {
	if (isSystemSensitiveWorkspace(workspaceDir)) return `TURNREWIND_WORKSPACE_UNSUPPORTED: ${workspaceDir} is a system directory`;
	const probe = probeWorkspace(workspaceDir);
	return probe.ok ? void 0 : probe.reason;
}
/** 解析 /undo 的输入行（turn id / 预览与冲突策略 / 两阶段 confirm/cancel / 诊断）。 */
function parseUndoInput(rawInput) {
	const parts = rawInput.trim().split(/\s+/u).filter(Boolean);
	let turnId;
	let dryRun = false;
	let preview = false;
	let skipConflicts = false;
	let force = false;
	let redo = false;
	let confirm = false;
	let cancel = false;
	let doctor = false;
	for (const part of parts) if (part === "--dry-run") dryRun = true;
	else if (part === "--preview") preview = true;
	else if (part === "--skip-conflicts") skipConflicts = true;
	else if (part === "--force") force = true;
	else if (part === "--redo") redo = true;
	else if (part === "--confirm") confirm = true;
	else if (part === "--cancel") cancel = true;
	else if (part === "--doctor") doctor = true;
	else if (part === "--subtree") return { error: "Recursive subtree undo is not available in the MVP." };
	else if (turnId === void 0) turnId = part;
	else return { error: "Usage: /undo [--preview] | /undo --confirm <plan-id> | /undo --cancel <plan-id> | /undo <turn-id> --force" };
	if (skipConflicts && force) return { error: "--skip-conflicts and --force are mutually exclusive." };
	if (redo && (turnId !== void 0 || dryRun || preview || skipConflicts || force || confirm || cancel)) return { error: "--redo cannot be combined with a turn id or other options." };
	if (doctor && (turnId !== void 0 || dryRun || preview || skipConflicts || force || redo || confirm || cancel)) return { error: "Usage: /undo --doctor (cannot be combined with other options)." };
	if ((confirm || cancel) && (dryRun || preview || skipConflicts || force)) return { error: "--confirm/--cancel cannot be combined with preview or conflict-override flags." };
	if (confirm && cancel) return { error: "--confirm and --cancel are mutually exclusive." };
	if ((confirm || cancel) && turnId === void 0) return { error: confirm ? "Usage: /undo --confirm <plan-id>" : "Usage: /undo --cancel <plan-id>" };
	return {
		turnId,
		dryRun,
		preview,
		skipConflicts,
		force,
		redo,
		confirm,
		cancel,
		doctor
	};
}
function assertSessionOwner(target, agent) {
	if (target.session_id !== agent.session.id) return {
		kind: "error",
		text: "The selected turn belongs to another session."
	};
}
function indent(text, prefix) {
	return text.split("\n").map((line) => prefix + line).join("\n");
}
async function safeDiffAgainstDisk(store, ref, path) {
	try {
		const { diffAgainstDisk } = await import("./git-snapshot-DSYOPzQJ.js");
		return await diffAgainstDisk(store, ref, path);
	} catch {
		return "(unable to inspect the on-disk file safely)";
	}
}
/** 冲突检测：不可检视路径（symlink/escape）按冲突处理。 */
async function diskMatchesSnapshot(runtime, workspaceDir, ref, path) {
	try {
		const { currentState: currentState$1 } = await import("./git-snapshot-DSYOPzQJ.js");
		return classifyUndo(await currentState$1(workspaceDir, path), await stateAt(runtime.store, ref, path)) !== "conflict";
	} catch {
		return false;
	}
}
/** 有界并发 map：大路径数的 undo 计划不再一次起满量 git 子进程（P1-7）。 */
async function mapWithConcurrency(items, limit, fn) {
	const results = Array.from({ length: items.length });
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}
/** 单个 plan 的路径并发预算：每条路径内部还有多次 git 子进程调用。 */
const PLAN_ENTRY_CONCURRENCY = 8;
/**
* 构建只读 undo 计划：每个路径的变化分类、磁盘是否仍匹配 turn 后快照、
* before 快照是否超限（超限条目恢复时单文件失败，绝不静默）。
*/
async function buildPlanEntries(runtime, workspaceDir, target, paths) {
	return mapWithConcurrency(paths, PLAN_ENTRY_CONCURRENCY, async (path) => {
		const beforeState = await stateAt(runtime.store, target.before_ref, path);
		return {
			path,
			change: await classifyPathChange(runtime.store, target.before_ref, target.after_ref, path),
			conflict: !await diskMatchesSnapshot(runtime, workspaceDir, target.after_ref, path),
			tooLarge: beforeState.kind === "tooLarge",
			unsupported: beforeState.kind === "unsupported"
		};
	});
}
function summarizeChanges(entries) {
	const counts = {
		modified: 0,
		created: 0,
		deleted: 0
	};
	for (const entry of entries) counts[entry.change] += 1;
	return `modified ${counts.modified}, created ${counts.created}, deleted ${counts.deleted}`;
}
/** P1-4：计划输出的规模上限——清单条数与逐文件 diff 都有界，防 UI/上下文膨胀。 */
const MAX_LISTED_FILES = 200;
const MAX_DIFF_FILES = 50;
function capList(items, max) {
	return {
		shown: items.slice(0, max),
		total: items.length,
		omitted: Math.max(0, items.length - max)
	};
}
function omittedNote(omitted, label) {
	return `  …and ${omitted} more ${label} (not listed)`;
}
async function formatPlan(runtime, target, entries, options) {
	const conflicts = entries.filter((entry) => entry.conflict);
	const oversized = entries.filter((entry) => entry.tooLarge);
	const unsupported = entries.filter((entry) => entry.unsupported);
	const lines = [];
	lines.push(`${options.preview ? "Undo preview" : options.dryRun ? "Undo plan" : "Undo preflight"}: turn ${target.turn_id}; ${entries.length} file(s) (${summarizeChanges(entries)}); ${conflicts.length} conflict(s).`);
	const listing = capList(entries.map((entry) => `${entry.change.padEnd(8)} ${entry.path}${entry.conflict ? " [conflict]" : ""}${entry.tooLarge ? " [too large]" : ""}${entry.unsupported ? " [unsupported]" : ""}`), MAX_LISTED_FILES);
	for (const line of listing.shown) lines.push(`  ${line}`);
	if (listing.omitted > 0) lines.push(omittedNote(listing.omitted, "file(s)"));
	if (oversized.length > 0) {
		lines.push("");
		lines.push(`Oversized files (over the ${MAX_FILE_BYTES / (1024 * 1024)} MB restore limit) cannot be restored by this undo; they will be reported as not restored:`);
		for (const entry of oversized) lines.push(`  ${entry.path}`);
	}
	if (unsupported.length > 0) {
		lines.push("");
		lines.push("Unrestorable entries (symlinks and other unsupported types in the before snapshot) will be reported as not restored; recreate them manually if intended:");
		for (const entry of unsupported) lines.push(`  ${entry.path}`);
	}
	if (options.preview || options.withDiffs) {
		lines.push("");
		lines.push("Undo will apply (turn output → restored state):");
		const diffFiles = capList(entries, MAX_DIFF_FILES);
		for (const entry of diffFiles.shown) {
			const diff = await snapshotFileDiff(runtime.store, target.after_ref, target.before_ref, entry.path);
			lines.push(`--- ${entry.path}`);
			lines.push(diff ? indent(diff, "  ") : "  (no textual diff)");
		}
		if (diffFiles.omitted > 0) lines.push(omittedNote(diffFiles.omitted, "diff(s)"));
	}
	if (conflicts.length > 0) {
		lines.push("");
		lines.push("Conflicts (turn output → current disk; undo would overwrite these changes):");
		const conflictFiles = capList(conflicts, MAX_DIFF_FILES);
		for (const entry of conflictFiles.shown) {
			const diff = await safeDiffAgainstDisk(runtime.store, target.after_ref, entry.path);
			lines.push(`--- ${entry.path}`);
			lines.push(diff ? indent(diff, "  ") : "  (no textual diff)");
		}
		if (conflictFiles.omitted > 0) lines.push(omittedNote(conflictFiles.omitted, "conflict diff(s)"));
		if (!options.dryRun && !options.preview) lines.push("Re-run with --skip-conflicts to restore only the non-conflicted files, or --force to overwrite the conflicts.");
	}
	return lines.join("\n");
}
const PLUGIN_NAME = "dsh-tauri-turnrewind";
function createRewindNoticeMessage(notice) {
	const paths = notice.paths.map((path) => `- ${path}`).join("\n");
	const turns = notice.turns.length > 0 ? notice.turns.join(", ") : notice.target_turn_id;
	const text = notice.kind === "redo" ? `[Turn rewind notice]\nA previous undo was redone; the file changes of these turns were re-applied: ${turns}.\n\nRe-applied files:\n${paths}\n\nTreat the current files on disk as authoritative. Re-read the listed files before making further edits.` : `[Turn rewind notice]\nThe workspace was reverted by these undo operations: ${turns}.\n\nReverted files in this operation:\n${paths}\n\nTreat the current files on disk as authoritative. Do not assume any reverted changes still exist; re-read the listed files before making further edits.`;
	return {
		id: `turnrewind-notice-${notice.notice_id}`,
		role: "user",
		content: [{
			type: "text",
			text
		}],
		source: {
			kind: "plugin",
			plugin: PLUGIN_NAME,
			form: "rewind-notice",
			sections: [{
				name: PLUGIN_NAME,
				text
			}]
		}
	};
}
function createSensitiveNoticeMessage(notice) {
	const text = [
		"[Turn rewind privacy notice]",
		"These sensitive-looking files are NOT ignored by the repository's ignore rules, so they are captured into the private snapshot repo and restored by /undo:",
		notice.paths.map((path) => `- ${path}`).join("\n"),
		"",
		"If that is not intended, add them to .gitignore or .git/info/exclude — the snapshot scope follows the repository's ignore rules on every capture."
	].join("\n");
	return {
		id: `turnrewind-notice-${notice.notice_id}`,
		role: "user",
		content: [{
			type: "text",
			text
		}],
		source: {
			kind: "plugin",
			plugin: PLUGIN_NAME,
			form: "rewind-privacy-notice",
			sections: [{
				name: PLUGIN_NAME,
				text
			}]
		}
	};
}
function createUnsupportedNoticeMessage(notice) {
	const text = `[Turn rewind unavailable]\nUndo is disabled for this workspace.\nReason: ${notice.reason}\n\nTurns here still run normally, but their file changes are not recorded, so /undo cannot revert them. Move this session to a normal project directory if you want undoable turns.`;
	return {
		id: `turnrewind-notice-${notice.notice_id}`,
		role: "user",
		content: [{
			type: "text",
			text
		}],
		source: {
			kind: "plugin",
			plugin: PLUGIN_NAME,
			form: "undo-unavailable-notice",
			sections: [{
				name: PLUGIN_NAME,
				text
			}]
		}
	};
}
function createNoticeMessage(notice) {
	if (notice.kind === "sensitive-files") return createSensitiveNoticeMessage({
		notice_id: notice.notice_id,
		paths: notice.paths ?? []
	});
	if (notice.kind === "unsupported") return createUnsupportedNoticeMessage({
		notice_id: notice.notice_id,
		reason: notice.reason ?? ""
	});
	return createRewindNoticeMessage({
		notice_id: notice.notice_id,
		kind: notice.kind,
		turns: notice.turns ?? [],
		target_turn_id: notice.target_turn_id ?? "",
		paths: notice.paths ?? []
	});
}
/** 共享 undo 执行器（命令路径与确认 HTTP 路由共用）。 */
async function executeUndoRestore(runtime, params) {
	const { sessionId, workspaceKey: workspaceKey$1, target, paths, entries, skipConflicts } = params;
	const lock = await acquireWorkspaceLock(runtime.store.rootDir, runtime.workspaceDir, { waitMs: 1e4 });
	try {
		const operationId = randomUUID();
		const beforeRef = `refs/turnrewind/operation-${operationId}`;
		await captureSnapshot(runtime.store, beforeRef, `turnrewind undo ${target.turn_id}`, runtime.parentRef);
		createOperation(runtime.db, {
			operationId,
			kind: "undo",
			targetTurnId: target.turn_id,
			requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
			beforeRef
		});
		try {
			const targets = skipConflicts ? entries.filter((entry) => !entry.conflict) : entries;
			const restoredPaths = [];
			const failedPaths = [];
			for (const entry of targets) {
				if (entry.unsupported) {
					failedPaths.push({
						path: entry.path,
						reason: "TURNREWIND_UNSUPPORTED_TARGET: snapshot entry is a symlink or otherwise unrestorable"
					});
					continue;
				}
				try {
					await restorePath(runtime.store, target.before_ref, entry.path);
					restoredPaths.push(entry.path);
				} catch (error) {
					failedPaths.push({
						path: entry.path,
						reason: String(error.message ?? error)
					});
				}
			}
			const skippedPaths = skipConflicts ? entries.filter((entry) => entry.conflict).map((entry) => entry.path) : [];
			completeUndoTransaction(runtime.db, {
				noticeId: randomUUID(),
				sessionId,
				workspaceKey: workspaceKey$1,
				targetTurnId: target.turn_id,
				restoredPaths,
				notRestored: failedPaths,
				operationId,
				createdAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			runtime.parentRef = beforeRef;
			let text = `Undid turn ${target.turn_id} and restored ${restoredPaths.length} file(s). The next model request will receive a rewind notice.`;
			if (skippedPaths.length > 0) text += ` Skipped ${skippedPaths.length} conflicted file(s): ${skippedPaths.join(", ")}.`;
			if (failedPaths.length > 0) text += ` Not restored (${failedPaths.length} file(s)): ${failedPaths.map((failure) => `${failure.path} (${failure.reason.includes("TURNREWIND_FILE_TOO_LARGE") ? "over the size limit" : failure.reason})`).join("; ")}.`;
			return text;
		} catch (error) {
			let rollbackError = null;
			try {
				const rollbackPaths = skipConflicts ? entries.filter((entry) => !entry.conflict).map((entry) => entry.path) : paths;
				for (const path of rollbackPaths) await restorePath(runtime.store, beforeRef, path);
				settleOperation(runtime.db, operationId, "rolled_back", error);
			} catch (rollbackFailure) {
				rollbackError = rollbackFailure;
			}
			if (rollbackError) throw new Error(`Undo and automatic recovery both failed: ${String(error)}; rollback failed: ${String(rollbackError)}`);
			throw new Error(`Undo failed and the pre-undo file state was restored: ${String(error)}`);
		}
	} finally {
		lock.release();
	}
}
async function turnRefsExist(store, turn) {
	if (!turn.before_ref || !turn.after_ref) return false;
	return Boolean(await gitRef(store.repoDir, store.workspaceDir, turn.before_ref) && await gitRef(store.repoDir, store.workspaceDir, turn.after_ref));
}
function workspaceHasActiveTurn(active, workspaceKey$1) {
	for (const entry of active.values()) if (entry.workspaceKey === workspaceKey$1) return true;
	return false;
}
async function applyUndo(runtime, active, invocation, env = {
	workspaceForAgent,
	workspaceIssue,
	workspaceKeyFor
}) {
	const parsed = parseUndoInput(invocation.rawInput);
	if ("error" in parsed) return {
		kind: "error",
		text: parsed.error
	};
	if (parsed.redo) return {
		kind: "error",
		text: "/undo --redo is temporarily disabled. The most recent undo cannot be re-applied for now."
	};
	const workspaceDir = env.workspaceForAgent(invocation.agent);
	if (!workspaceDir) {
		const cwd = invocation.agent?.session?.header?.cwd;
		const issue = typeof cwd === "string" && cwd.length > 0 ? env.workspaceIssue(resolve(cwd)) : void 0;
		if (issue) return {
			kind: "error",
			text: `Undo is unavailable for this workspace. ${issue}`
		};
		return {
			kind: "error",
			text: "Undo is unavailable because this session has no workspace."
		};
	}
	const workspaceKey$1 = env.workspaceKeyFor(workspaceDir);
	if (workspaceHasActiveTurn(active, workspaceKey$1)) return {
		kind: "error",
		text: "Undo is unavailable while an Agent turn is still active in this workspace."
	};
	if (runtime.undoing) return {
		kind: "error",
		text: "Another undo operation is already running in this workspace."
	};
	if (parsed.redo) return applyRedo(runtime, invocation, workspaceDir, workspaceKey$1);
	if (parsed.cancel) return {
		kind: "success",
		text: markPendingPlanCancelled(runtime.db, parsed.turnId, invocation.agent.session.id) ? "Pending undo cancelled." : "No pending undo plan matched (it may have expired or already run)."
	};
	let target;
	let planRow;
	let pendingPlanClaimed = false;
	let pendingPlanCommitted = false;
	const abortPendingPlanClaim = () => {
		if (pendingPlanClaimed) {
			releasePendingPlanClaim(runtime.db, parsed.turnId);
			pendingPlanClaimed = false;
		}
		runtime.undoing = false;
	};
	try {
		if (parsed.confirm) {
			const claim = claimPendingPlan(runtime.db, parsed.turnId, invocation.agent.session.id);
			if (!claim.ok) return {
				kind: "error",
				text: claim.error
			};
			pendingPlanClaimed = true;
			runtime.undoing = true;
			planRow = claim.row;
			const pendingTurnId = claim.row.turn_id;
			target = getTurn(runtime.db, pendingTurnId);
			if (!target || !await turnRefsExist(runtime.store, target)) {
				abortPendingPlanClaim();
				return {
					kind: "error",
					text: "The pending plan's snapshot data no longer exists. Run /undo again to preview a fresh plan."
				};
			}
		} else if (parsed.turnId) {
			runtime.undoing = true;
			target = getTurn(runtime.db, parsed.turnId);
			if (target && !await turnRefsExist(runtime.store, target)) {
				runtime.undoing = false;
				return {
					kind: "error",
					text: `The snapshot data for turn ${parsed.turnId} no longer exists (the snapshot repository was previously wiped); its changes can no longer be undone.`
				};
			}
		} else {
			runtime.undoing = true;
			for (const candidate of listReversibleTurns(runtime.db, invocation.agent.session.id, workspaceKey$1)) {
				if (await turnRefsExist(runtime.store, candidate)) {
					target = candidate;
					break;
				}
				markTurnSnapshotMissing(runtime.db, candidate.turn_id);
			}
		}
	} catch (error) {
		abortPendingPlanClaim();
		throw error;
	}
	if (!target) {
		runtime.undoing = false;
		const latest = getLatestTurnSummary(runtime.db, invocation.agent.session.id, workspaceKey$1);
		return {
			kind: "error",
			text: `No reversible turn was found for this session.${latest ? ` Latest turn ${latest.turn_id} is ${latest.status} (reversible=${latest.reversible}).` : ""}`
		};
	}
	const ownershipError = assertSessionOwner(target, invocation.agent);
	if (ownershipError) {
		runtime.undoing = false;
		abortPendingPlanClaim();
		return ownershipError;
	}
	if (target.workspace_key !== workspaceKey$1) {
		runtime.undoing = false;
		abortPendingPlanClaim();
		return {
			kind: "error",
			text: "The selected turn belongs to another workspace."
		};
	}
	if (!["settled", "interrupted"].includes(target.status) || target.reversible !== 1 || !target.before_ref || !target.after_ref) {
		runtime.undoing = false;
		abortPendingPlanClaim();
		return {
			kind: "error",
			text: "The selected turn does not have a complete reversible snapshot."
		};
	}
	runtime.undoing = true;
	try {
		const paths = await snapshotDiff(runtime.store, target.before_ref, target.after_ref);
		if (planRow) {
			const drift = planDrift(planRow, target, paths);
			if (drift) {
				abortPendingPlanClaim();
				return {
					kind: "error",
					text: `${drift} — run /undo again to preview a fresh plan.`
				};
			}
		}
		if (paths.length === 0) {
			if (pendingPlanClaimed) {
				markPendingPlanApplied(runtime.db, parsed.turnId, invocation.agent.session.id, "No file changes were recorded for this turn.");
				pendingPlanCommitted = true;
			}
			return {
				kind: "success",
				text: "No file changes were recorded for this turn."
			};
		}
		const entries = await buildPlanEntries(runtime, workspaceDir, target, paths);
		const conflicts = entries.filter((entry) => entry.conflict);
		const directExecute = parsed.force || parsed.skipConflicts;
		if (parsed.dryRun) return {
			kind: "success",
			text: await formatPlan(runtime, target, entries, parsed)
		};
		if (!directExecute && !parsed.confirm) {
			const planText = await formatPlan(runtime, target, entries, {
				...parsed,
				withDiffs: true
			});
			if (conflicts.length > 0) return {
				kind: parsed.preview ? "success" : "error",
				text: planText
			};
			const planId = createPendingPlan(runtime.db, {
				sessionId: invocation.agent.session.id,
				workspaceKey: workspaceKey$1,
				turnId: target.turn_id,
				paths,
				beforeRef: target.before_ref,
				afterRef: target.after_ref
			});
			return {
				kind: "success",
				text: `${planText}\nplan ${planId}\nSend /undo --confirm ${planId} to apply, or /undo --cancel ${planId} to dismiss.`
			};
		}
		if (parsed.confirm && conflicts.length > 0) {
			abortPendingPlanClaim();
			return {
				kind: "error",
				text: `The workspace changed since the preview (${conflicts.length} conflicted file(s)). Run /undo again to refresh the plan; use --force/--skip-conflicts deliberately if needed.`
			};
		}
		try {
			const text = await executeUndoRestore(runtime, {
				sessionId: invocation.agent.session.id,
				workspaceKey: workspaceKey$1,
				target,
				paths,
				entries,
				skipConflicts: parsed.skipConflicts
			});
			if (parsed.confirm) {
				markPendingPlanApplied(runtime.db, parsed.turnId, invocation.agent.session.id, text);
				pendingPlanCommitted = true;
			}
			return {
				kind: "success",
				text
			};
		} catch (error) {
			return {
				kind: "error",
				text: String(error?.message ?? error)
			};
		}
	} finally {
		if (pendingPlanClaimed && !pendingPlanCommitted) abortPendingPlanClaim();
		else runtime.undoing = false;
	}
}

//#endregion
export { hasNeedsRecoveryWorkspace as A, registerWorkspace as B, claimRewindNotices as C, getPendingPlanRow as D, getLatestTurnSummary as E, markPendingPlanCancelled as F, skipTurn as G, settleInterruptedTurn as H, openLedger as I, pruneConsumedNotices as L, insertTurn as M, listRecoveryWorkspaces as N, getPendingPlanStatus as O, markPendingPlanApplied as P, queueSensitiveNotice as R, claimPendingPlan as S, getLatestSnapshotRef as T, settleNoopTurn as U, releasePendingPlanClaim as V, settleTurn as W, withWorkspaceLock as _, executeUndoRestore as a, isSystemSensitiveWorkspace as b, turnRefsExist as c, workspaceHasActiveTurn as d, workspaceIssue as f, acquireWorkspaceLockSync as g, acquireWorkspaceLock as h, createNoticeMessage as i, hasSensitiveNotice as j, getTurn as k, workspaceForAgent as l, WorkspaceLockBusyError as m, assertSessionOwner as n, formatPlan as o, workspaceKeyFor as p, buildPlanEntries as r, parseUndoInput as s, applyUndo as t, workspaceForSession as u, classifyUndo as v, failTurn as w, acknowledgeRecovery as x, planDrift as y, recordSkippedTurn as z };