import { C as MAX_ROUTE_BODY_BYTES, E as SYNC_GIT_TIMEOUT_MS, T as SNAPSHOT_REF_PREFIX, _ as workspaceHash, b as gitWorkspace, c as gitRef, d as restorePath, f as runGit, g as stateAt, h as snapshotFileDiff, i as currentState, l as probeWorkspace, m as snapshotDiff, o as gitAvailable, p as runGitText, r as createSnapshotStore, s as gitExitIsClean, t as captureSnapshot, u as restoreCrashedSwaps, v as workspaceKey, x as MAX_ENDED_TURNS, y as gitUnavailableReason } from "./git-snapshot-zS8H1aWQ.js";
import { A as hasNeedsRecoveryWorkspace, B as registerWorkspace, C as claimRewindNotices, D as getPendingPlanRow, E as getLatestTurnSummary, F as markPendingPlanCancelled, G as skipTurn, H as settleInterruptedTurn, I as openLedger, L as pruneConsumedNotices, M as insertTurn, N as listRecoveryWorkspaces, O as getPendingPlanStatus, P as markPendingPlanApplied, R as queueSensitiveNotice, S as claimPendingPlan, T as getLatestSnapshotRef, U as settleNoopTurn, V as releasePendingPlanClaim, W as settleTurn, _ as withWorkspaceLock, a as executeUndoRestore, b as isSystemSensitiveWorkspace, c as turnRefsExist, d as workspaceHasActiveTurn, f as workspaceIssue, g as acquireWorkspaceLockSync, h as acquireWorkspaceLock, j as hasSensitiveNotice, k as getTurn, l as workspaceForAgent, m as WorkspaceLockBusyError, o as formatPlan, p as workspaceKeyFor, r as buildPlanEntries, s as parseUndoInput, t as applyUndo, u as workspaceForSession, v as classifyUndo, w as failTurn, x as acknowledgeRecovery, y as planDrift, z as recordSkippedTurn } from "./undo-Baxytf_6.js";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import process from "node:process";
import { join, resolve } from "pathe";
import { Buffer } from "node:buffer";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

//#region src/shared/constants.ts
/**
* shared/constants.ts — 跨 host/client 的稳定协议常量。
*
* API 前缀与插件名是两半端共享的线协议面：host 路由注册、client RPC 各自硬编码
* 会漂移，集中在此由两端共同引用。
*/
/** 插件名（诊断元数据 / registrant / storage key 前缀）。 */
const TURNREWIND_PLUGIN_NAME = "dsh-tauri-turnrewind";
/** HTTP 路由前缀（host route + client rpc 同源 fetch）。 */
const TURNREWIND_API_PREFIX = "/api/turnrewind";
/** 弹窗去重的 localStorage 基名（不带冒号，driver 侧拼前缀）。 */
const TURNREWIND_STORAGE_BASE = "dsh-tauri-turnrewind";

//#endregion
//#region src/host/routes/index.ts
/**
* host/routes/index.ts — 同源 HTTP 路由（/api/turnrewind/*）。
*
* ✓/✗ 按钮经此驱动两阶段确认：confirm（POST，loopback-only）原子 claim 后执行；
* cancel（POST）；status（GET）供卡片轮询 plan 结局。与 worktree 插件的
* jsonRoute 模式一致：方法严格限制、body 上限、变更仅回环。
*
* P1-3 加固：响应一次性 guard（异常客户端不会触发重复响应/崩溃）、
* body 超限立即 413 并断开、mutate 路由校验 JSON Content-Type、
* 统一 nosniff/no-store 响应头、处理超时兜底（长 undo 由 status 轮询
* 恢复，响应中断不影响服务端继续执行）。
*/
function jsonRoute(path, handler, { mutate = false, methods = [], timeoutMs = 12e4 } = {}) {
	const allowed = new Set(methods.map((m) => m.toUpperCase()));
	if (mutate) allowed.add("POST");
	return {
		kind: "exact",
		path,
		handler(req, res) {
			let responded = false;
			const send = (code, payload) => {
				if (responded) return;
				responded = true;
				const body = JSON.stringify(payload);
				res.writeHead(code, {
					"content-type": "application/json; charset=utf-8",
					"x-content-type-options": "nosniff",
					"cache-control": "no-store"
				});
				res.end(body);
			};
			const timeout = setTimeout(send, timeoutMs, 504, { error: "request timed out; the operation may still complete — poll /api/turnrewind/status" });
			const finish = () => {
				clearTimeout(timeout);
			};
			if (mutate && req.method !== "POST") {
				res.setHeader("allow", "POST");
				finish();
				send(405, { error: "mutation routes require POST" });
				return;
			}
			if (allowed.size > 0 && !allowed.has((req.method ?? "").toUpperCase())) {
				res.setHeader("allow", [...allowed].join(", "));
				finish();
				send(405, { error: "method not allowed" });
				return;
			}
			const parts = [];
			let totalBytes = 0;
			let tooLarge = false;
			req.on("data", (chunk) => {
				if (tooLarge) return;
				const value = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
				totalBytes += value.length;
				if (totalBytes > MAX_ROUTE_BODY_BYTES) {
					tooLarge = true;
					finish();
					send(413, { error: "request body too large" });
					req.destroy?.(/* @__PURE__ */ new Error("body too large"));
					return;
				}
				parts.push(value);
			});
			req.on("error", () => {
				finish();
				send(400, { error: "request stream failed" });
			});
			req.on("end", () => {
				(async () => {
					if (tooLarge) return finish();
					if (mutate) {
						const peer = req.socket?.remoteAddress ?? "";
						if (!(peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1")) return send(403, { error: "mutation routes only accept loopback calls" });
						const contentType = req.headers?.["content-type"];
						const type = Array.isArray(contentType) ? contentType[0] : contentType;
						if (!type || !type.toLowerCase().includes("application/json")) return send(415, { error: "content-type must be application/json" });
					}
					try {
						const [code, payload] = await handler(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"), req);
						finish();
						send(code, payload);
					} catch (error) {
						finish();
						send(500, { error: String(error?.message ?? error) });
					}
				})();
			});
		}
	};
}

//#endregion
//#region src/host/service/dialog-projection.ts
/**
* host/service/dialog-projection.ts — `turnrewind` 会话投影。
*
* 把插件注入的 unsupported-workspace heads-up 消息折叠进会话列表快照，客户端半
* 据此弹窗。纯函数、单测覆盖；index.ts 的注册是唯一 effect。
*/
const UNSUPPORTED_MARKER = "[Turn rewind unavailable]";
const MAX_TRACKED_NOTICES = 20;
/** 提取一条 user/message 事件里的 heads-up 负载（按插件 source 匹配，文本标记兜底）。 */
function extractUnsupportedNotice(event) {
	const candidate = event;
	if (candidate?.type !== "user/message") return void 0;
	const message = candidate.data;
	const text = Array.isArray(message?.content) ? message.content.find((part) => part?.type === "text")?.text : void 0;
	const source = message?.source;
	if (!(source?.plugin === "dsh-tauri-turnrewind" && source?.form === "undo-unavailable-notice" || typeof text === "string" && text.startsWith(UNSUPPORTED_MARKER)) || typeof message?.id !== "string") return void 0;
	const reason = typeof text === "string" ? /^Reason: (.+)$/mu.exec(text)?.[1] : void 0;
	return {
		id: message.id,
		reason: reason ?? ""
	};
}
function parseNoticesValue(value) {
	if (typeof value !== "object" || value === null || !Array.isArray(value.notices)) throw new Error("TURNREWIND_PROJECTION_SHAPE: expected { notices: Array<{ id, reason }> }");
	return value;
}
/**
* Build the `turnrewind` projection unit. Registered on `ctx.sessionProjections`;
* the registry requires `.parse` validators — hand-rolled ones keep this plugin
* dependency-free.
*/
function createDialogProjection() {
	return {
		key: "turnrewind",
		stateVersion: 1,
		stateSchema: { parse: parseNoticesValue },
		init: () => ({ notices: [] }),
		apply(state, event) {
			const notice = extractUnsupportedNotice(event);
			if (!notice || state.notices.some((existing) => existing.id === notice.id)) return state;
			return { notices: [...state.notices, notice].slice(-MAX_TRACKED_NOTICES) };
		},
		wire: {
			viewSchema: { parse: parseNoticesValue },
			view: (state) => ({ notices: state.notices })
		}
	};
}

//#endregion
//#region src/host/service/doctor.ts
async function describeSnapshotRepo(store) {
	const repoDir = store.repoDir;
	if (!existsSync(join(repoDir, "HEAD"))) return `${repoDir} — not created yet (no turn captured for this workspace)`;
	let refCount = 0;
	try {
		refCount = (await runGitText(repoDir, store.workspaceDir, [
			"for-each-ref",
			"--format=%(refname)",
			SNAPSHOT_REF_PREFIX
		])).split("\n").filter(Boolean).length;
	} catch (error) {
		return `${repoDir} — error listing refs: ${String(error.message ?? error)}`;
	}
	const storage = existsSync(join(repoDir, "objects", "info", "alternates")) ? "borrows source objects (alternates)" : "self-contained";
	return `${repoDir} — ${refCount} snapshot ref(s), ${storage}`;
}
function describeBackup(dataRoot) {
	const backupPath = join(dataRoot, "ledger.sqlite.bak");
	const stat = statSync(backupPath, { throwIfNoEntry: false });
	if (!stat) return `${backupPath} — missing (written on the first host open)`;
	return `${backupPath} — ${Math.round((Date.now() - stat.mtimeMs) / 36e5)}h old`;
}
/**
* 汇总一份诊断报告（纯文本，多行）。入参只依赖账本与数据根，agent 仅用于
* 会话归属与工作区定位；任何一节失败都降级为该节的 error 行。
*/
async function collectDoctorReport(db, dataRoot, agent) {
	const lines = ["Turn rewind doctor"];
	try {
		const available = await gitAvailable();
		lines.push(`git: ${available ? "available" : "NOT FOUND on PATH (turns run, undo is disabled)"}`);
	} catch (error) {
		lines.push(`git: error — ${String(error.message ?? error)}`);
	}
	const workspaceDir = workspaceForSession(agent?.session);
	if (workspaceDir) lines.push(`workspace: ${workspaceDir} (git worktree, eligible)`);
	else {
		const cwd = agent?.session?.header?.cwd;
		const issue = typeof cwd === "string" && cwd.length > 0 ? workspaceIssue(cwd) : void 0;
		lines.push(`workspace: NOT ELIGIBLE${issue ? ` — ${issue}` : " (session has no cwd)"}`);
	}
	try {
		const counts = {
			turns: Number(db.prepare("SELECT COUNT(*) AS n FROM turns").get()?.n ?? 0),
			operations: Number(db.prepare("SELECT COUNT(*) AS n FROM operations").get()?.n ?? 0),
			pendingNotices: Number(db.prepare("SELECT COUNT(*) AS n FROM rewind_notices WHERE status = 'pending'").get()?.n ?? 0),
			pendingPlans: Number(db.prepare("SELECT COUNT(*) AS n FROM pending_plans WHERE status = 'pending'").get()?.n ?? 0)
		};
		lines.push(`ledger: healthy (opened with quick_check) — ${counts.turns} turn(s), ${counts.operations} operation(s), ${counts.pendingNotices} pending notice(s), ${counts.pendingPlans} pending plan(s)`);
		const fenced = listRecoveryWorkspaces(db);
		if (fenced.length === 0) lines.push("recovery fence: none");
		else {
			lines.push(`recovery fence: ${fenced.length} workspace(s) BLOCKED — open the recovery panel to resolve`);
			for (const workspace of fenced) lines.push(`  - ${workspace.workspace_path ?? workspace.workspace_key}: ${workspace.operations.map((op) => `${op.kind} → ${op.target_turn_id}`).join("; ")}`);
		}
	} catch (error) {
		lines.push(`ledger: error — ${String(error.message ?? error)}`);
	}
	try {
		const cwd = agent?.session?.header?.cwd;
		const key = workspaceDir ? workspaceKeyFor(workspaceDir) : typeof cwd === "string" && cwd.length > 0 ? workspaceKeyFor(cwd) : void 0;
		const latest = key ? getLatestTurnSummary(db, agent.session.id, key) : void 0;
		lines.push(`latest turn in this session: ${latest ? `${latest.turn_id} is ${latest.status} (reversible=${latest.reversible})` : "none recorded"}`);
	} catch (error) {
		lines.push(`latest turn: error — ${String(error.message ?? error)}`);
	}
	if (workspaceDir) try {
		const store = createSnapshotStore(dataRoot, workspaceDir);
		lines.push(`snapshot repo: ${await describeSnapshotRepo(store)}`);
	} catch (error) {
		lines.push(`snapshot repo: error — ${String(error.message ?? error)}`);
	}
	try {
		lines.push(`ledger backup: ${describeBackup(dataRoot)}`);
	} catch (error) {
		lines.push(`ledger backup: error — ${String(error.message ?? error)}`);
	}
	return lines.map((line, index) => index === 0 || line.startsWith("  ") ? line : `- ${line}`).join("\n");
}

//#endregion
//#region src/host/service/maintenance.ts
/**
* host/service/maintenance.ts — 工作区级 turnrewind 数据清除。
*
* 只删除本插件自己的 snapshot repo 与账本行；用户 .git、工作区文件与其他
* workspace 的数据绝不触碰（maintenance.test 钉死）。
*/
function resolveRootDir(explicit) {
	if (explicit) return resolve(explicit);
	return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
}
/**
* Remove every piece of turnrewind data bound to one workspace: the private
* snapshot repository on disk and all ledger rows that reference it.
*
* 跨进程互斥（P1-1）：purge 是破坏性维护操作，与运行中的 Host（快照捕获、
* undo 等）互斥；workspace 被占用时直接抛 WorkspaceLockBusyError，由 CLI
* 提示先停止 Host 再执行。
*/
function purgeWorkspace(rootDir$1, workspaceDir) {
	const workspaceIdentity = workspaceKey(workspaceDir);
	const repoDir = join(rootDir$1, "snapshots", `${workspaceHash(workspaceDir)}.git`);
	const summary = {
		rootDir: rootDir$1,
		repoDir,
		repoExisted: false,
		ledger: void 0
	};
	const lock = acquireWorkspaceLockSync(rootDir$1, workspaceDir);
	try {
		if (existsSync(join(rootDir$1, "ledger.sqlite"))) {
			const db = openLedger(rootDir$1);
			try {
				db.exec("BEGIN IMMEDIATE");
				const operations = db.prepare("DELETE FROM operations WHERE target_turn_id IN (SELECT turn_id FROM turns WHERE workspace_key = ?)").run(workspaceIdentity);
				const notices = db.prepare("DELETE FROM rewind_notices WHERE workspace_key = ?").run(workspaceIdentity);
				const plans = db.prepare("DELETE FROM pending_plans WHERE workspace_key = ?").run(workspaceIdentity);
				const turns = db.prepare("DELETE FROM turns WHERE workspace_key = ?").run(workspaceIdentity);
				const workspaces = db.prepare("DELETE FROM workspaces WHERE workspace_key = ?").run(workspaceIdentity);
				db.exec("COMMIT");
				summary.ledger = {
					operations: Number(operations.changes),
					notices: Number(notices.changes),
					plans: Number(plans.changes),
					turns: Number(turns.changes),
					workspaces: Number(workspaces.changes)
				};
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {}
				throw error;
			} finally {
				db.close();
			}
		}
		summary.repoExisted = existsSync(repoDir);
		rmSync(repoDir, {
			recursive: true,
			force: true
		});
		return summary;
	} finally {
		lock.release();
	}
}

//#endregion
//#region src/host/service/retention.ts
/** 每个 workspace 保留的最近可撤销 turn 数。 */
const DEFAULT_RETAIN_TURNS = 50;
/** 快照仓库容量上限（MB），超过即整仓重建。 */
const DEFAULT_MAX_SNAPSHOT_MB = 1024;
function readPositiveEnv(name$1) {
	const raw = process.env[name$1];
	if (raw === void 0 || raw === "") return void 0;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : void 0;
}
function directorySizeMb(dir) {
	let total = 0;
	const visit = (path) => {
		let entries;
		try {
			entries = readdirSync(path, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (entry.isFile()) try {
				total += Number(statSync(full).size);
			} catch {}
		}
	};
	visit(dir);
	return total / (1024 * 1024);
}
/**
* 回收私有仓库中不可达的 loose object。主要来源是 diffAgainstDisk 把冲突文件
* 的当前磁盘内容 `hash-object -w` 进仓库：这些对象没有任何 ref 可达，反复
* 预览/冲突 diff 会持续积累，是提前触发整仓重建的主因。prune 只删除不可达
* 对象（refs/turnrewind/* 链上的对象不受影响），放在容量测量之前，让上限
* 判断基于治理后的真实占用。同步执行：与 git-workspace 的 rev-parse 同级，
* 仅在 workspace 首次触碰（每进程每仓库一次）发生。
*/
function pruneRepoLooseObjects(repoDir) {
	if (!existsSync(join(repoDir, "HEAD"))) return;
	try {
		spawnSync("git", [
			"--git-dir",
			repoDir,
			"prune",
			"--expire=now"
		], {
			timeout: SYNC_GIT_TIMEOUT_MS,
			killSignal: "SIGKILL"
		});
	} catch {}
}
/**
* 对一个 workspace 执行容量治理。在无活动 turn / 无 undo 的安全点调用
* （当前唯一调用点：ensureRuntime 的 workspace 首次触碰，调用方持跨进程
* workspace 锁）。
*/
function enforceRetention(db, store, options = {}) {
	const retainTurns = options.retainTurns ?? readPositiveEnv("TURNREWIND_RETAIN_TURNS") ?? DEFAULT_RETAIN_TURNS;
	const maxSnapshotMb = options.maxSnapshotMb ?? readPositiveEnv("TURNREWIND_MAX_SNAPSHOT_MB") ?? DEFAULT_MAX_SNAPSHOT_MB;
	const workspaceIdentity = workspaceKey(store.workspaceDir);
	const result = {
		expiredByCount: 0,
		rebuilt: false,
		expiredByRebuild: 0,
		repoSizeMb: 0
	};
	const reversible = db.prepare(`
    SELECT turn_id FROM turns
    WHERE workspace_key = ? AND reversible = 1 AND status IN ('settled', 'interrupted')
    ORDER BY started_at DESC
  `).all(workspaceIdentity);
	const excess = reversible.slice(retainTurns);
	const expire = db.prepare(`
    UPDATE turns SET reversible = 0,
      error = 'retention: beyond the most recent kept reversible turns'
    WHERE turn_id = ? AND reversible = 1
  `);
	for (const row of excess) result.expiredByCount += Number(expire.run(row.turn_id).changes);
	pruneRepoLooseObjects(store.repoDir);
	result.repoSizeMb = directorySizeMb(store.repoDir);
	if (result.repoSizeMb > maxSnapshotMb) {
		const quarantine = `${store.repoDir}.retention-quarantine`;
		rmSync(quarantine, {
			recursive: true,
			force: true
		});
		const affected = db.prepare(`
      SELECT turn_id FROM turns
      WHERE workspace_key = ? AND reversible = 1 AND status IN ('settled', 'interrupted')
    `).all(workspaceIdentity);
		db.prepare(`
      UPDATE turns SET reversible = 0,
        error = 'retention: snapshot repository rebuilt (size cap)'
      WHERE workspace_key = ? AND reversible = 1 AND status IN ('settled', 'interrupted')
    `).run(workspaceIdentity);
		try {
			renameSync(store.repoDir, quarantine);
		} catch (error) {
			const revert = db.prepare(`UPDATE turns SET reversible = 1, error = NULL WHERE turn_id = ?`);
			for (const row of affected) revert.run(row.turn_id);
			throw error;
		}
		try {
			rmSync(quarantine, {
				recursive: true,
				force: true
			});
		} catch {}
		result.rebuilt = true;
		result.expiredByRebuild = reversible.length;
	}
	return result;
}

//#endregion
//#region src/host/service/sensitive.ts
/**
* host/service/sensitive.ts — 秘密文件快照提醒（启发式，只提醒不改变语义）。
*
* Git 目录模式把快照面完全委托给源仓库 ignore 规则：未写进 ignore 的
* .env/密钥类文件会被捕获进私有快照并可被 /undo 恢复（这是有意的取舍，
* 见 README「快照范围与敏感文件」）。本模块在会话首次追踪某工作区时做一次
* 浅层扫描（根 + 两层，上限 500 个文件，跳过 .git/node_modules 等噪音目录），
* 命中启发式再经 `git check-ignore --stdin` 批量过滤掉已 ignore 的文件——
* 剩下的就是"会被快照的疑似秘密"，由调用方写成每会话/工作区一条的
* heads-up notice。扫描/探测失败一律静默降级为"无发现"：这是提醒，不是门禁。
*/
/**
* 基名启发式：.env*、证书/密钥扩展名、常见凭据文件名。宁可漏报不误报——
* 提醒的措辞由调用方承担，这里只负责"看起来像秘密"。
*/
const SENSITIVE_NAME = [
	/^\.env$/i,
	/^\.env\./i,
	/\.(pem|key|pfx|p12|keystore|jks)$/i,
	/^id_rsa/i,
	/^credentials/i,
	/^secrets?/i,
	/^\.npmrc$/i
];
function isSensitiveName(name$1) {
	return SENSITIVE_NAME.some((re) => re.test(name$1));
}
const MAX_SCAN_FILES = 500;
const MAX_SCAN_DEPTH = 2;
const SKIP_DIRS = new Set([
	".git",
	".turnrewind",
	"node_modules"
]);
function collectCandidates(root, rel, depth, out) {
	if (out.length >= MAX_SCAN_FILES) return;
	let entries;
	try {
		entries = readdirSync(rel === "" ? root : join(root, rel), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (out.length >= MAX_SCAN_FILES) return;
		const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name) || depth >= MAX_SCAN_DEPTH) continue;
			collectCandidates(root, childRel, depth + 1, out);
			continue;
		}
		if (entry.isFile() && isSensitiveName(entry.name)) out.push(childRel);
	}
}
/**
* `git check-ignore -z --stdin` 批量过滤：返回未被 ignore 的候选。
* git 缺失/超时/异常路径一律返回全部候选（宁可多提醒一次）。
*/
function filterIgnored(workspaceDir, candidates) {
	if (candidates.length === 0) return Promise.resolve([]);
	return new Promise((resolvePromise) => {
		const child = spawn("git", [
			"-c",
			"core.quotepath=false",
			"check-ignore",
			"-z",
			"--stdin"
		], {
			cwd: workspaceDir,
			env: { ...process.env }
		});
		const chunks = [];
		let settled = false;
		let timeout;
		const settle = (value) => {
			if (settled) return;
			settled = true;
			if (timeout !== void 0) clearTimeout(timeout);
			resolvePromise(value);
		};
		timeout = setTimeout(() => {
			child.kill("SIGKILL");
			settle(candidates);
		}, SYNC_GIT_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.stdin.on("error", () => {});
		child.on("error", () => settle(candidates));
		child.on("close", (code) => {
			if (code !== 0 && code !== 1) return settle(candidates);
			const ignored = new Set(Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean));
			settle(candidates.filter((file) => !ignored.has(file)));
		});
		child.stdin.end(candidates.join("\0"));
	});
}
/** 未被 ignore 的疑似秘密文件（工作区相对、正斜杠路径）。 */
async function findUnignoredSensitiveFiles(workspaceDir) {
	const candidates = [];
	collectCandidates(workspaceDir, "", 0, candidates);
	return filterIgnored(workspaceDir, candidates);
}

//#endregion
//#region src/host/apply.ts
/** 插件名（诊断元数据，与 shared/constants 的 TURNREWIND_PLUGIN_NAME 一致）。 */
const name = "dsh-tauri-turnrewind";
/**
* 需要的宿主服务：
*   commands             /undo 人类命令
*   sessionProjections   不可用弹窗的会话投影
*   webServer            /api/turnrewind/*（卡内 ✓/✗ 与状态轮询）
*/
const inject = [
	"commands",
	"sessionProjections",
	"webServer"
];
function rootDir() {
	return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
}
function createDeferred() {
	let resolve$1;
	return {
		promise: new Promise((resolvePromise) => {
			resolve$1 = resolvePromise;
		}),
		resolve: resolve$1
	};
}
function settleDeferred(deferred, value) {
	deferred.resolve(value);
}
/** turn 前后快照 ref：turnId 的 sha256 前 32 位 + 阶段后缀，稳定且不进用户 refs 命名空间。 */
function turnSnapshotRef(turnId, phase) {
	return `refs/turnrewind/turn-${createHash("sha256").update(turnId).digest("hex").slice(0, 32)}-${phase}`;
}
function activeKey(sessionId, turn) {
	return `${sessionId}:${turn}`;
}
function waitForTurnBaseline(activeTurns, sessionId, turn, signal) {
	const entry = activeTurns.get(activeKey(sessionId, turn));
	if (!entry?.baseline) return Promise.resolve(void 0);
	if (!signal) return entry.baseline.promise;
	signal.throwIfAborted();
	return new Promise((resolvePromise, rejectPromise) => {
		const onAbort = () => {
			rejectPromise(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		entry.baseline.promise.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolvePromise(value);
		});
	});
}
async function settleActiveTurn(ledger, active, key, reason) {
	const current = active.get(key);
	if (!current || current.runtime.disposed) return;
	try {
		await withWorkspaceLock(current.runtime.store.rootDir, current.runtime.workspaceDir, async () => {
			const afterRef = turnSnapshotRef(current.turnId, "after");
			await captureSnapshot(current.runtime.store, afterRef, `turnrewind after ${current.turnId}`, current.runtime.parentRef);
			if (current.runtime.disposed) return;
			const changed = await snapshotDiff(current.runtime.store, current.beforeRef, afterRef);
			if (current.runtime.disposed) return;
			if (changed.length === 0) settleNoopTurn(ledger, current.turnId, afterRef);
			else if (reason) settleInterruptedTurn(ledger, current.turnId, afterRef, reason);
			else settleTurn(ledger, current.turnId, afterRef);
			current.runtime.parentRef = afterRef;
		}, { waitMs: 5e3 });
	} catch (error) {
		if (!current.runtime.disposed) failTurn(ledger, current.turnId, error);
	} finally {
		active.delete(key);
	}
}
async function settleSessionTurns(ledger, active, sessionId, exceptKey, reason) {
	for (const [key, entry] of [...active.entries()]) {
		if (key === exceptKey || !key.startsWith(`${sessionId}:`) || !entry.baselineReady) continue;
		await settleActiveTurn(ledger, active, key, reason);
	}
}
function apply(ctx) {
	const dataRoot = rootDir();
	const ledger = openLedger(dataRoot);
	const log = {
		warn: (message) => {
			if (ctx.logger?.warn) ctx.logger.warn(message);
			else console.warn(message);
		},
		error: (message) => {
			if (ctx.logger?.error) ctx.logger.error(message);
			else console.error(message);
		}
	};
	pruneConsumedNotices(ledger);
	const active = /* @__PURE__ */ new Map();
	const untrackedTurns = /* @__PURE__ */ new Set();
	const workspaceStores = /* @__PURE__ */ new Map();
	let disposed = false;
	const commands = ctx.commands;
	ctx.effect(() => ctx.sessionProjections.register(createDialogProjection()), "turnrewind projection");
	const sessionChains = /* @__PURE__ */ new Map();
	const endedTurns = /* @__PURE__ */ new Map();
	function enqueueTurnTask(sessionId, task) {
		const next = (sessionChains.get(sessionId) ?? Promise.resolve()).then(task);
		const settled = next.catch(() => {});
		sessionChains.set(sessionId, settled);
		settled.then(() => {
			if (sessionChains.get(sessionId) === settled) sessionChains.delete(sessionId);
		});
		return next;
	}
	function rememberEndedTurn(key) {
		const alreadyEnded = endedTurns.has(key);
		endedTurns.set(key, true);
		while (endedTurns.size > MAX_ENDED_TURNS) endedTurns.delete(endedTurns.keys().next().value);
		return alreadyEnded;
	}
	function ensureRuntime(agent) {
		const workspaceDir = workspaceForAgent(agent);
		if (!workspaceDir) return void 0;
		const workspaceKey$1 = workspaceKeyFor(workspaceDir);
		let runtime = workspaceStores.get(workspaceKey$1);
		if (!runtime) {
			const store = createSnapshotStore(dataRoot, workspaceDir);
			const latest = getLatestSnapshotRef(ledger, workspaceKey$1);
			registerWorkspace(ledger, workspaceKey$1, workspaceDir, store.repoDir);
			const resurrected = restoreCrashedSwaps(workspaceDir);
			for (const path of resurrected) log.warn(`turnrewind: resurrected ${path} in ${workspaceDir} from a crashed restore swap`);
			try {
				const retentionLock = acquireWorkspaceLockSync(dataRoot, workspaceDir);
				try {
					const retention = enforceRetention(ledger, store);
					if (retention.expiredByCount > 0) log.warn(`turnrewind: retention expired ${retention.expiredByCount} turn(s) in ${workspaceDir} (kept the most recent ones)`);
					if (retention.rebuilt) log.warn(`turnrewind: snapshot repository for ${workspaceDir} rebuilt by retention (${retention.repoSizeMb.toFixed(1)} MB over the cap; ${retention.expiredByRebuild} turn(s) archived)`);
				} finally {
					retentionLock.release();
				}
			} catch (error) {
				if (error instanceof WorkspaceLockBusyError) log.warn(`turnrewind: workspace busy; snapshot retention skipped this time for ${workspaceDir}`);
				else log.error(`turnrewind: snapshot retention failed for ${workspaceDir}: ${String(error)}`);
			}
			runtime = {
				db: ledger,
				store,
				workspaceKey: workspaceKey$1,
				workspaceDir,
				parentRef: latest,
				undoing: false,
				disposed: false
			};
			workspaceStores.set(workspaceKey$1, runtime);
		}
		return runtime;
	}
	function recordSkipped(turnId, sessionId, workspaceKey$1, startedAt, reason, notify = true) {
		untrackedTurns.add(turnId);
		try {
			if (notify) recordSkippedTurn(ledger, {
				turnId,
				sessionId,
				workspaceKey: workspaceKey$1,
				startedAt
			}, reason);
			else skipTurn(ledger, {
				turnId,
				sessionId,
				workspaceKey: workspaceKey$1,
				startedAt
			}, reason);
		} catch (error) {
			log.error(`turnrewind: failed to record skipped turn ${turnId}: ${String(error)}`);
		}
		log.error(`turnrewind: skipped turn ${turnId}: ${reason}`);
	}
	function reserveTurnBaseline(agent, turn) {
		if (disposed) return void 0;
		const sessionId = agent.session.id;
		const key = activeKey(sessionId, turn);
		const existing = active.get(key);
		if (existing) return existing;
		if (untrackedTurns.has(key) || endedTurns.has(key)) return void 0;
		if (getTurn(ledger, key)) return void 0;
		const startedAt = (/* @__PURE__ */ new Date()).toISOString();
		const workspaceDir = workspaceForAgent(agent);
		if (!workspaceDir) {
			const cwd = agent?.session?.header?.cwd;
			if (typeof cwd === "string" && cwd.length > 0) {
				const issue$1 = workspaceIssue(resolve(cwd));
				if (issue$1) recordSkipped(key, sessionId, workspaceKeyFor(resolve(cwd)), startedAt, issue$1);
			}
			return;
		}
		const workspaceKey$1 = workspaceKeyFor(workspaceDir);
		if (hasNeedsRecoveryWorkspace(ledger, workspaceKey$1)) {
			recordSkipped(key, sessionId, workspaceKey$1, startedAt, "TURNREWIND_RECOVERY_REQUIRED: a previous undo or redo was interrupted; inspect the workspace and clear its recovery state before using rewind again");
			return;
		}
		const issue = workspaceIssue(workspaceDir);
		if (issue) {
			recordSkipped(key, sessionId, workspaceKey$1, startedAt, issue);
			return;
		}
		const runtime = ensureRuntime(agent);
		if (!runtime) return void 0;
		if (runtime.undoing) {
			recordSkipped(key, sessionId, workspaceKey$1, startedAt, "TURNREWIND_WORKSPACE_BUSY: an undo operation is running");
			return;
		}
		for (const entry$1 of active.values()) if (entry$1.workspaceKey === workspaceKey$1 && entry$1.sessionId !== sessionId) {
			recordSkipped(key, sessionId, workspaceKey$1, startedAt, "TURNREWIND_WORKSPACE_BUSY: another session is using this workspace");
			return;
		}
		const beforeRef = turnSnapshotRef(key, "before");
		const baseline = createDeferred();
		const entry = {
			runtime,
			sessionId,
			workspaceKey: runtime.workspaceKey,
			turnId: key,
			beforeRef,
			baseline,
			baselineReady: false,
			startedAt,
			turn
		};
		active.set(key, entry);
		const baselineTask = async () => {
			if (disposed || active.get(key) !== entry) {
				settleDeferred(baseline, {
					ok: false,
					reason: "turn was replaced before baseline capture"
				});
				return;
			}
			try {
				const available = await gitAvailable();
				if (disposed || runtime.disposed) {
					settleDeferred(baseline, {
						ok: false,
						reason: "turnrewind plugin disposed during baseline capture"
					});
					return;
				}
				if (!available) {
					active.delete(key);
					const reason = "TURNREWIND_GIT_UNAVAILABLE: the git executable was not found on PATH; file undo is disabled";
					recordSkipped(key, sessionId, runtime.workspaceKey, startedAt, reason);
					settleDeferred(baseline, {
						ok: false,
						reason
					});
					return;
				}
				await settleSessionTurns(ledger, active, sessionId, key, "interrupted by a newer turn in the same session");
				if (disposed || runtime.disposed) {
					settleDeferred(baseline, {
						ok: false,
						reason: "turnrewind plugin disposed during baseline capture"
					});
					return;
				}
				await withWorkspaceLock(dataRoot, runtime.workspaceDir, async () => {
					if (disposed || runtime.disposed) return;
					await captureSnapshot(runtime.store, beforeRef, `turnrewind before ${key}`, runtime.parentRef);
					if (disposed || runtime.disposed) return;
					insertTurn(ledger, {
						turnId: key,
						sessionId,
						workspaceKey: runtime.workspaceKey,
						startedAt,
						beforeRef
					});
					entry.baselineReady = true;
				}, { waitMs: 5e3 });
				if (disposed || runtime.disposed) {
					settleDeferred(baseline, {
						ok: false,
						reason: "turnrewind plugin disposed during baseline capture"
					});
					return;
				}
				if (!disposed && !runtime.disposed && !hasSensitiveNotice(ledger, sessionId, runtime.workspaceKey)) try {
					const sensitive = await findUnignoredSensitiveFiles(runtime.workspaceDir);
					if (sensitive.length > 0) queueSensitiveNotice(ledger, sessionId, runtime.workspaceKey, sensitive);
				} catch (scanError) {
					log.warn(`turnrewind: sensitive-file scan failed (ignored): ${String(scanError)}`);
				}
				settleDeferred(baseline, { ok: true });
			} catch (error) {
				active.delete(key);
				const reason = error instanceof WorkspaceLockBusyError ? error.message : `TURNREWIND_CAPTURE_FAILED: ${String(error)}`;
				if (!disposed && !runtime.disposed) recordSkipped(key, sessionId, runtime.workspaceKey, startedAt, reason, false);
				settleDeferred(baseline, {
					ok: false,
					reason
				});
				if (!disposed && !runtime.disposed) log.error(`turnrewind: failed to start turn ${key}: ${String(error)}`);
			}
		};
		enqueueTurnTask(sessionId, baselineTask).catch((error) => {
			if (active.get(key) === entry) active.delete(key);
			const reason = `TURNREWIND_CAPTURE_FAILED: ${String(error)}`;
			if (!disposed && !runtime.disposed) recordSkipped(key, sessionId, runtime.workspaceKey, startedAt, reason, false);
			settleDeferred(baseline, {
				ok: false,
				reason
			});
			if (!disposed && !runtime.disposed) log.error(`turnrewind: baseline queue failed for ${key}: ${String(error)}`);
		});
		return entry;
	}
	const PLAN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const validPlanId = (value) => PLAN_ID_RE.test(value);
	const validSessionId = (value) => value.length >= 1 && value.length <= 200 && [...value].every((ch) => ch.charCodeAt(0) > 31);
	ctx.effect(() => {
		function confirmRoute(body) {
			const planId = String(body.planId ?? "");
			const sessionId = String(body.sessionId ?? "");
			if (planId === "" || sessionId === "") return [400, { error: "planId and sessionId are required" }];
			if (!validPlanId(planId) || !validSessionId(sessionId)) return [400, { error: "planId or sessionId is malformed" }];
			const previewRow = getPendingPlanRow(ledger, planId);
			if (previewRow === void 0) return [404, { error: "plan not found — run /undo again" }];
			if (previewRow.session_id !== sessionId) return [403, { error: "the plan belongs to another session" }];
			if (previewRow.status === "expired") return [409, { error: "this plan has expired — run /undo again to preview a fresh plan" }];
			if (previewRow.status !== "pending") return [409, { error: "this plan was already applied or cancelled — run /undo again" }];
			const planRuntime = workspaceStores.get(previewRow.workspace_key);
			if (planRuntime === void 0) return [409, { error: "the host restarted since this preview; run /undo again" }];
			if (hasNeedsRecoveryWorkspace(ledger, previewRow.workspace_key)) return [409, { error: "TURNREWIND_RECOVERY_REQUIRED: the workspace needs recovery (a previous operation was interrupted) — open the recovery panel to resolve" }];
			if (planRuntime.undoing || workspaceHasActiveTurn(active, previewRow.workspace_key)) return [409, { error: "the workspace is busy — wait for the current turn to finish" }];
			const claim = claimPendingPlan(ledger, planId, sessionId);
			if (!claim.ok) return [claim.code, { error: claim.error }];
			const row = claim.row;
			planRuntime.undoing = true;
			let committed = false;
			return (async () => {
				try {
					const target = getTurn(ledger, row.turn_id);
					if (target === void 0 || target.reversible !== 1 || !target.before_ref || !target.after_ref || !await turnRefsExist(planRuntime.store, target)) return [409, { error: "the planned turn's snapshot data no longer exists — run /undo again" }];
					const paths = await snapshotDiff(planRuntime.store, target.before_ref, target.after_ref);
					const drift = planDrift(row, target, paths);
					if (drift) return [409, { error: `${drift} — run /undo again to refresh the plan` }];
					if (paths.length === 0) {
						markPendingPlanApplied(ledger, planId, sessionId, "No file changes were recorded for this turn.");
						committed = true;
						return [200, {
							ok: true,
							message: "No file changes were recorded for this turn."
						}];
					}
					const entries = await buildPlanEntries(planRuntime, planRuntime.workspaceDir, target, paths);
					const conflicts = entries.filter((entry) => entry.conflict);
					if (conflicts.length > 0) return [409, { error: `the workspace changed since the preview (${conflicts.length} conflicted file(s)) — run /undo again to refresh the plan` }];
					let message;
					try {
						message = await executeUndoRestore(planRuntime, {
							sessionId,
							workspaceKey: row.workspace_key,
							target,
							paths,
							entries,
							skipConflicts: false
						});
					} catch (error) {
						if (error instanceof WorkspaceLockBusyError) return [409, { error: `${error.message} — retry shortly` }];
						throw error;
					}
					markPendingPlanApplied(ledger, planId, sessionId, message);
					committed = true;
					return [200, {
						ok: true,
						message
					}];
				} finally {
					if (!committed) releasePendingPlanClaim(ledger, planId);
					planRuntime.undoing = false;
				}
			})();
		}
		function cancelRoute(body) {
			const planId = String(body.planId ?? "");
			const sessionId = String(body.sessionId ?? "");
			if (planId === "" || sessionId === "") return [400, { error: "planId and sessionId are required" }];
			if (!validPlanId(planId) || !validSessionId(sessionId)) return [400, { error: "planId or sessionId is malformed" }];
			const row = getPendingPlanRow(ledger, planId);
			if (row === void 0) return [404, { error: "plan not found — run /undo again" }];
			if (row.session_id !== sessionId) return [403, { error: "the plan belongs to another session" }];
			if (row.status === "cancelled") return [200, {
				ok: true,
				message: "Pending undo cancelled."
			}];
			if (row.status === "expired") return [409, { error: "this plan has expired — run /undo again to preview a fresh plan" }];
			if (row.status === "applied") return [409, { error: "this plan was already applied" }];
			if (row.status === "applying") return [409, { error: "this plan is being applied — wait for it to finish" }];
			if (!markPendingPlanCancelled(ledger, planId, sessionId)) return [409, { error: "this plan was already applied or cancelled — run /undo again" }];
			return [200, {
				ok: true,
				message: "Pending undo cancelled."
			}];
		}
		function recoveryRoute() {
			return [200, { workspaces: listRecoveryWorkspaces(ledger) }];
		}
		function recoveryResolveRoute(body) {
			const workspaceKey$1 = String(body.workspaceKey ?? "");
			const mode = String(body.mode ?? "");
			if (mode !== "acknowledge" && mode !== "purge" || workspaceKey$1 === "" || workspaceKey$1.length > 500) return [400, { error: "workspaceKey and mode (acknowledge|purge) are required" }];
			if (listRecoveryWorkspaces(ledger).find((workspace) => workspace.workspace_key === workspaceKey$1) === void 0) return [404, { error: "this workspace is not under recovery" }];
			if (mode === "acknowledge") return [200, {
				ok: true,
				acknowledged: acknowledgeRecovery(ledger, workspaceKey$1)
			}];
			try {
				return [200, {
					ok: true,
					purged: purgeWorkspace(dataRoot, workspaceKey$1)
				}];
			} catch (error) {
				if (error instanceof WorkspaceLockBusyError) return [409, { error: `${error.message} — stop the host process using this workspace first` }];
				throw error;
			}
		}
		function statusRoute(_body, req) {
			const url = new URL(req.url ?? "/", "http://localhost");
			const planId = String(url.searchParams.get("planId") ?? "");
			const sessionId = String(url.searchParams.get("sessionId") ?? "");
			if (planId === "" || sessionId === "") return [400, { error: "planId and sessionId are required" }];
			if (!validPlanId(planId) || !validSessionId(sessionId)) return [400, { error: "planId or sessionId is malformed" }];
			const status = getPendingPlanStatus(ledger, planId, sessionId);
			if (status === void 0) return [404, { error: "plan expired, unavailable, or owned by another session — run /undo again" }];
			return [200, status];
		}
		const disposers = [
			jsonRoute(`${TURNREWIND_API_PREFIX}/confirm`, confirmRoute, { mutate: true }),
			jsonRoute(`${TURNREWIND_API_PREFIX}/cancel`, cancelRoute, { mutate: true }),
			jsonRoute(`${TURNREWIND_API_PREFIX}/status`, statusRoute, { methods: ["GET"] }),
			jsonRoute(`${TURNREWIND_API_PREFIX}/recovery`, recoveryRoute, { methods: ["GET"] }),
			jsonRoute(`${TURNREWIND_API_PREFIX}/recovery/resolve`, recoveryResolveRoute, { mutate: true })
		].map((route) => ctx.webServer.register(route));
		return () => disposers.map((dispose) => dispose());
	}, "turnrewind routes");
	ctx.on("agent/pre-step", async ({ agent, turn, signal }, next) => {
		const key = activeKey(agent.session.id, turn);
		const entry = active.get(key) ?? (untrackedTurns.has(key) || endedTurns.has(key) ? void 0 : reserveTurnBaseline(agent, turn));
		await waitForTurnBaseline(active, agent.session.id, turn, signal);
		signal.throwIfAborted();
		if (disposed) return { kind: "reject" };
		if (!entry && workspaceForAgent(agent) && !untrackedTurns.has(key) && !endedTurns.has(key)) log.error(`turnrewind: no baseline reservation for ${key}; turn is explicitly untracked`);
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted || disposed) return decision;
		const cwd = agent?.session?.header?.cwd;
		const workspaceDir = workspaceForAgent(agent) ?? (typeof cwd === "string" && cwd.length > 0 ? resolve(cwd) : void 0);
		if (!workspaceDir) return decision;
		const notices = claimRewindNotices(ledger, agent.session.id, workspaceKeyFor(workspaceDir));
		if (notices.length === 0) return decision;
		const { createNoticeMessage } = await import("./undo-CsJc1fDj.js");
		return {
			...decision,
			messages: [...decision.messages ?? [], ...notices.map((notice) => createNoticeMessage(notice))]
		};
	});
	ctx.on("agent/inbox/claimed", (payload) => {
		if (!disposed) reserveTurnBaseline(payload.agent, payload.turn);
	});
	ctx.on("session/event", (session, event) => {
		if (disposed || event.type !== "turn/end" || typeof event.data?.turn !== "number") return;
		const key = activeKey(session.id, event.data.turn);
		rememberEndedTurn(key);
		if (untrackedTurns.delete(key)) return;
		if (!active.has(key)) return;
		const reason = event.data.reason?.kind;
		const interrupted = reason === "aborted" || reason === "error" || reason === "cancelled";
		enqueueTurnTask(session.id, () => settleActiveTurn(ledger, active, key, interrupted ? `turn ended with ${reason}` : void 0));
	});
	ctx.on("agent/turn-stopping", () => {});
	ctx.on("agent/error", (payload) => {
		log.error(`turnrewind: observed agent error for ${activeKey(payload.agent.session.id, payload.turn)}: ${String(payload.error)}`);
	});
	ctx.on("agent/status", ({ agent, status }) => {
		if (disposed || status !== "idle") return;
		const sessionId = agent.session.id;
		for (const key of [...active.keys()]) if (key.startsWith(`${sessionId}:`)) enqueueTurnTask(sessionId, () => settleActiveTurn(ledger, active, key, "agent became idle after interruption"));
	});
	ctx.effect(() => () => {
		disposed = true;
		for (const runtime of workspaceStores.values()) runtime.disposed = true;
		for (const entry of active.values()) settleDeferred(entry.baseline, {
			ok: false,
			reason: "turnrewind plugin disposed during baseline capture"
		});
		active.clear();
		untrackedTurns.clear();
		endedTurns.clear();
		workspaceStores.clear();
		return (async () => {
			await Promise.allSettled([...sessionChains.values()]);
			ledger.close();
		})();
	}, "turnrewind runtime");
	ctx.effect(() => commands.register({
		name: "undo",
		description: "Plan or undo file changes made by the latest Agent turn",
		input: { hint: "[turn-id] [--dry-run|--preview] [--skip-conflicts|--force] | --doctor" },
		handler: (invocation) => {
			const parsed = parseUndoInput(invocation.rawInput);
			if (!("error" in parsed) && parsed.doctor) return collectDoctorReport(ledger, dataRoot, invocation.agent).then((text) => ({
				kind: "success",
				text
			}));
			const workspaceDir = workspaceForAgent(invocation.agent);
			if (!workspaceDir) {
				const cwd = invocation.agent?.session?.header?.cwd;
				const issue$1 = typeof cwd === "string" && cwd.length > 0 ? workspaceIssue(resolve(cwd)) : void 0;
				if (issue$1) return {
					kind: "error",
					text: `Undo is unavailable for this workspace. ${issue$1}`
				};
				return {
					kind: "error",
					text: "Undo is unavailable because this session has no workspace."
				};
			}
			if (hasNeedsRecoveryWorkspace(ledger, workspaceKeyFor(workspaceDir))) return {
				kind: "error",
				text: "TURNREWIND_RECOVERY_REQUIRED: a previous undo or redo was interrupted. Open the recovery panel (from the \"Turn rewind unavailable\" notice) to inspect the workspace, keep the history acknowledged, or clear its rewind data."
			};
			const issue = workspaceIssue(workspaceDir);
			if (issue) return {
				kind: "error",
				text: `Undo is unavailable for this workspace. ${issue}`
			};
			const runtime = ensureRuntime(invocation.agent);
			if (!runtime) return {
				kind: "error",
				text: "Undo is unavailable because the Git workspace could not be initialized."
			};
			return applyUndo(runtime, active, {
				rawInput: invocation.rawInput,
				agent: invocation.agent
			}, {
				workspaceForAgent,
				workspaceIssue,
				workspaceKeyFor
			});
		}
	}), "turnrewind command");
}

//#endregion
export { TURNREWIND_API_PREFIX, TURNREWIND_PLUGIN_NAME, TURNREWIND_STORAGE_BASE, WorkspaceLockBusyError, acquireWorkspaceLock, acquireWorkspaceLockSync, apply, applyUndo, buildPlanEntries, captureSnapshot, classifyUndo, createDialogProjection, createSnapshotStore, currentState, enforceRetention, executeUndoRestore, formatPlan, gitAvailable, gitExitIsClean, gitRef, gitUnavailableReason, gitWorkspace, inject, isSystemSensitiveWorkspace, jsonRoute, name, openLedger, parseUndoInput, probeWorkspace, purgeWorkspace, resolveRootDir, restoreCrashedSwaps, restorePath, runGit, snapshotDiff, snapshotFileDiff, stateAt, turnRefsExist, turnSnapshotRef, waitForTurnBaseline, withWorkspaceLock, workspaceHash, workspaceKey };