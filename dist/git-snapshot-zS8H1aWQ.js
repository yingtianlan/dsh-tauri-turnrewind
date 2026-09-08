import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import process from "node:process";
import { basename, dirname, join, relative, resolve, sep } from "pathe";
import { Buffer } from "node:buffer";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

//#region src/host/constants/index.ts
/**
* host/constants/index.ts — 宿主侧私有常量。
*/
/** 单文件快照/恢复上限（64 MiB；blob 超限单文件报告，不炸整体 undo）。 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** git 子进程输出上限。 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** 异步 git 子进程墙钟预算（SIGKILL 兜底）。 */
const GIT_SUBPROCESS_TIMEOUT_MS = 300 * 1e3;
/** 可用性探测预算（探测喂给 pre-step barrier，挂起即卡 turn）。 */
const GIT_PROBE_TIMEOUT_MS = 30 * 1e3;
/** 可用性探测失败后的重试间隔。 */
const GIT_PROBE_RETRY_MS = 300 * 1e3;
/** 同步 rev-parse 的预算（本地元数据查询，慢于此即视为卡死）。 */
const SYNC_GIT_TIMEOUT_MS = 15 * 1e3;
/** 快照 refs 允许的前缀（拒绝其他 refs 命名空间与路径穿越）。 */
const SNAPSHOT_REF_PREFIX = "refs/turnrewind/";
/** Git symlink 条目的 mode 值（P1-3：stateAt/restore 据此拒绝，而非伪装成文件）。 */
const GIT_SYMLINK_MODE = "120000";
/** 原子替换的 bak 后缀。 */
const BAK_SUFFIX = ".turnrewind-restore.bak";
/** 快照排除规则（git pathspec；ignore 语义委托源仓库）。 */
const SNAPSHOT_PATHSPECS = [
	":(exclude,glob).git/**",
	":(exclude,glob)**/.git/**",
	":(exclude,glob).turnrewind/**",
	":(exclude,glob)**/.turnrewind/**",
	":(exclude,glob)**/*.turnrewind-*.tmp",
	":(exclude,glob)**/*.turnrewind-restore.bak"
];
/** pending plan 存活时长（只影响未执行的预览；settled 结果行永久保留可追溯）。 */
const PENDING_PLAN_TTL_MS = 300 * 1e3;
/** endedTurns 内存上界。 */
const MAX_ENDED_TURNS = 500;
/** HTTP 路由 body 上限。 */
const MAX_ROUTE_BODY_BYTES = 16 * 1024;

//#endregion
//#region src/host/service/git-workspace.ts
const MAX_OUTPUT_BYTES$1 = 1024 * 1024;
let gitExecutableMissing = false;
/** git 不在 PATH 时报告真实原因（否则会把正常 worktree 误报为非 worktree）。 */
function gitUnavailableReason() {
	return gitExecutableMissing ? "TURNREWIND_GIT_UNAVAILABLE: the git executable was not found on PATH; file undo is disabled" : void 0;
}
function runGitSync(workspaceDir, args) {
	const result = spawnSync("git", [
		"-c",
		"core.quotepath=false",
		...args
	], {
		cwd: workspaceDir,
		env: { ...process.env },
		encoding: "utf8",
		maxBuffer: MAX_OUTPUT_BYTES$1,
		timeout: SYNC_GIT_TIMEOUT_MS,
		killSignal: "SIGKILL"
	});
	if (result.error) return {
		ok: false,
		error: result.error
	};
	if (result.status !== 0) return {
		ok: false,
		stderr: String(result.stderr ?? "").trim(),
		status: void 0
	};
	return {
		ok: true,
		stdout: String(result.stdout ?? "").trim()
	};
}
/**
* 解析 canonical Git worktree 与其元数据，不改变任何 Git 状态。
* 非 worktree 返回 undefined；git 缺失置 gitUnavailableReason 的标志。
*/
const WORKSPACE_CACHE_TTL_MS = 60 * 1e3;
const workspaceCache = /* @__PURE__ */ new Map();
/**
* 单次 rev-parse 同时解析全部元数据：原先每次冷解析要 6 个 spawnSync，
* 现在合并为 1 个子进程，输出行序与参数顺序一致。
*/
const REV_PARSE_ARGS = [
	"rev-parse",
	"--is-inside-work-tree",
	"--show-toplevel",
	"--git-dir",
	"--git-common-dir",
	"--git-path",
	"index",
	"--git-path",
	"info/exclude"
];
/**
* realpathSync 安全包装：路径不存在时原样返回。macOS 上 /var → /private/var 的
* symlink 在这里归一。用 `.native` 而非 plain realpathSync 是 Windows 的硬要求：
* libuv 的 JS-path 实现不会展开 8.3 短名（TEMP=C:\Users\RUNNER~1\... 原样保留），
* 而 `.native`（GetFinalPathNameByHandle）展开为磁盘上的长名——git 的
* --show-toplevel 输出的正是长名。若这里不展开，工作区以短名/长名两次调用
* gitWorkspace → 相对 .git 解析出不同字符串 → ensureRepository 的 gitDir 恒等
* 检查永远失败（TURNREWIND_GIT_REPOSITORY）。pathe resolve 统一正斜杠。
*/
function safeRealpath(p) {
	try {
		return resolve(realpathSync.native(p));
	} catch {
		return resolve(p);
	}
}
function resolveInfo(requestedDir, stdout) {
	const lines = stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
	if (lines.length < 6 || lines[0] !== "true") return void 0;
	const workspaceRoot = safeRealpath(resolve(requestedDir, lines[1]));
	const resolvedGitDir = safeRealpath(resolve(requestedDir, lines[2]));
	const resolvedCommonDir = safeRealpath(resolve(requestedDir, lines[3]));
	const resolvedIndex = resolve(requestedDir, lines[4]);
	const resolvedInfoExclude = resolve(requestedDir, lines[5]);
	if (!existsSync(workspaceRoot) || !existsSync(resolvedGitDir) || !existsSync(resolvedCommonDir)) return void 0;
	return {
		workspaceDir: workspaceRoot,
		requestedDir,
		gitDir: resolvedGitDir,
		commonDir: resolvedCommonDir,
		indexPath: resolvedIndex,
		infoExcludePath: resolvedInfoExclude
	};
}
function evictOldest() {
	if (workspaceCache.size <= 64) return;
	const oldest = [...workspaceCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
	workspaceCache.delete(oldest[0]);
}
/** 后台刷新（stale-while-revalidate 的异步半边）：结果直接落缓存。 */
const refreshInflight = /* @__PURE__ */ new Map();
function refreshWorkspaceAsync(requestedDir) {
	if (refreshInflight.has(requestedDir)) return;
	const task = new Promise((resolvePromise) => {
		const child = spawn("git", [
			"-c",
			"core.quotepath=false",
			...REV_PARSE_ARGS
		], {
			cwd: requestedDir,
			env: { ...process.env }
		});
		const chunks = [];
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			resolvePromise({
				info: void 0,
				gitMissing: false
			});
		}, SYNC_GIT_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error.code === "ENOENT") gitExecutableMissing = true;
			resolvePromise({
				info: void 0,
				gitMissing: error.code === "ENOENT"
			});
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolvePromise({
				info: code === 0 ? resolveInfo(requestedDir, Buffer.concat(chunks).toString("utf8")) : void 0,
				gitMissing: false
			});
		});
	}).then((result) => {
		refreshInflight.delete(requestedDir);
		if (!result.gitMissing) workspaceCache.set(requestedDir, {
			at: Date.now(),
			info: result.info,
			gitMissing: false
		});
	}).catch(() => {
		refreshInflight.delete(requestedDir);
	});
	refreshInflight.set(requestedDir, task);
}
function gitWorkspace(workspaceDir) {
	const requestedDir = resolve(workspaceDir);
	gitExecutableMissing = false;
	const cached = workspaceCache.get(requestedDir);
	if (cached && Date.now() - cached.at < WORKSPACE_CACHE_TTL_MS) return cached.info;
	if (cached) {
		refreshWorkspaceAsync(requestedDir);
		return cached.info;
	}
	const result = runGitSync(requestedDir, REV_PARSE_ARGS);
	if (result.error?.code === "ENOENT") {
		gitExecutableMissing = true;
		return;
	}
	const info = result.ok ? resolveInfo(requestedDir, result.stdout ?? "") : void 0;
	workspaceCache.set(requestedDir, {
		at: Date.now(),
		info,
		gitMissing: false
	});
	evictOldest();
	return info;
}

//#endregion
//#region src/host/service/git-snapshot.ts
/** 退出判定：只有干净退出（code 0、无信号）才可 resolve。 */
function gitExitIsClean(code, signal) {
	return code === 0 && (signal === null || signal === void 0);
}
/**
* 异步执行一条 git 命令（不阻塞事件循环）。SIGKILL 预算防卡死；外部击杀
* （close(null, signal) 且非自身超时）reject——resolve 半截输出会把残缺 index
* 提交成 turn 快照。
*/
function runGit(repoDir, workspaceDir, args, extraEnv = {}, maxBytes = MAX_OUTPUT_BYTES) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("git", [
			"-c",
			"core.quotepath=false",
			"--git-dir",
			repoDir,
			"--work-tree",
			workspaceDir,
			...args
		], {
			cwd: workspaceDir,
			env: {
				...process.env,
				...extraEnv
			}
		});
		const chunks = [];
		const errors = [];
		let total = 0;
		let settled = false;
		let timeout;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.kill("SIGKILL");
			rejectPromise(error);
		};
		timeout = setTimeout(() => fail(/* @__PURE__ */ new Error(`TURNREWIND_GIT_TIMEOUT: git ${args.join(" ")} exceeded ${GIT_SUBPROCESS_TIMEOUT_MS / 1e3}s`)), GIT_SUBPROCESS_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			if (settled) return;
			total += chunk.length;
			if (total > maxBytes) {
				fail(/* @__PURE__ */ new Error(`TURNREWIND_OUTPUT_TOO_LARGE: git output exceeded ${maxBytes} bytes`));
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			if (!settled) errors.push(chunk);
		});
		child.on("error", (error) => fail(/* @__PURE__ */ new Error(`TURNREWIND_GIT_EXEC: ${error.message}`)));
		child.on("close", (code, signal) => {
			if (settled) return;
			const stdout = Buffer.concat(chunks);
			if (!gitExitIsClean(code, signal)) {
				const detail = Buffer.concat(errors).toString("utf8").trim() || stdout.toString("utf8").trim() || (signal ? `killed by ${signal}` : `exit ${code}`);
				fail(/* @__PURE__ */ new Error(`TURNREWIND_GIT_FAILED: ${detail}`));
				return;
			}
			settled = true;
			clearTimeout(timeout);
			resolvePromise(stdout);
		});
	});
}
/** 导出给 doctor 等只读诊断使用（与 runGit 同一击杀/超时语义）。 */
async function runGitText(repoDir, workspaceDir, args, extraEnv = {}) {
	return (await runGit(repoDir, workspaceDir, args, extraEnv)).toString("utf8");
}
/** 带管道输入的 git 执行（hash-object -w --stdin 等）；同样的击杀/超时语义。 */
function runGitStdin(repoDir, workspaceDir, args, input) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("git", [
			"-c",
			"core.quotepath=false",
			"--git-dir",
			repoDir,
			"--work-tree",
			workspaceDir,
			...args
		], {
			cwd: workspaceDir,
			env: { ...process.env }
		});
		const chunks = [];
		const errors = [];
		let settled = false;
		let timeout;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.kill("SIGKILL");
			rejectPromise(error);
		};
		timeout = setTimeout(() => fail(/* @__PURE__ */ new Error(`TURNREWIND_GIT_TIMEOUT: git ${args.join(" ")} exceeded ${GIT_SUBPROCESS_TIMEOUT_MS / 1e3}s`)), GIT_SUBPROCESS_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.stderr.on("data", (chunk) => errors.push(chunk));
		child.on("error", (error) => fail(/* @__PURE__ */ new Error(`TURNREWIND_GIT_EXEC: ${error.message}`)));
		child.on("close", (code, signal) => {
			if (settled) return;
			if (!gitExitIsClean(code, signal)) {
				fail(/* @__PURE__ */ new Error(`TURNREWIND_GIT_FAILED: ${Buffer.concat(errors).toString("utf8").trim() || (signal ? `killed by ${signal}` : `exit ${code}`)}`));
				return;
			}
			settled = true;
			clearTimeout(timeout);
			resolvePromise(Buffer.concat(chunks));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}
let gitProbeResult;
let gitProbeFailedAt = 0;
/**
* PATH 上是否有可用的 git。成功探测进程级缓存；失败探测按 GIT_PROBE_RETRY_MS
* 过期重试（进程内装好 git/修好 PATH 无需重启 Host）。探测喂给 pre-step barrier，
* 无预算挂起的 `git --version` 会永远卡住 turn。
*/
function gitAvailable() {
	if (gitProbeResult !== void 0 && gitProbeFailedAt > 0 && Date.now() - gitProbeFailedAt > GIT_PROBE_RETRY_MS) {
		gitProbeResult = void 0;
		gitProbeFailedAt = 0;
	}
	gitProbeResult ??= new Promise((resolvePromise) => {
		const child = spawn("git", ["--version"]);
		let settled = false;
		let probeTimeout;
		const settle = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(probeTimeout);
			resolvePromise(value);
		};
		const markFailure = () => {
			gitProbeFailedAt = Date.now();
		};
		probeTimeout = setTimeout(() => {
			markFailure();
			child.kill("SIGKILL");
			settle(false);
		}, GIT_PROBE_TIMEOUT_MS);
		child.on("error", () => {
			markFailure();
			settle(false);
		});
		child.on("close", (code, signal) => {
			if (code !== 0 || signal !== null) markFailure();
			settle(code === 0 && signal === null);
		});
	});
	return gitProbeResult;
}
async function ensureRepository(store) {
	const { repoDir, workspaceDir, sourceCommonDir, sourceInfoExclude } = store;
	const source = gitWorkspace(workspaceDir);
	if (!source || source.gitDir !== store.sourceGitDir) throw new Error(`TURNREWIND_GIT_REPOSITORY: ${workspaceDir} is not the expected Git worktree`);
	if (!existsSync(join(repoDir, "HEAD"))) {
		mkdirSync(dirname(repoDir), { recursive: true });
		await new Promise((resolvePromise, rejectPromise) => {
			const child = spawn("git", [
				"init",
				"--bare",
				repoDir
			]);
			const errors = [];
			let settled = false;
			const timeout = setTimeout(() => {
				settled = true;
				child.kill("SIGKILL");
				rejectPromise(/* @__PURE__ */ new Error(`TURNREWIND_GIT_TIMEOUT: git init exceeded ${GIT_SUBPROCESS_TIMEOUT_MS / 1e3}s`));
			}, GIT_SUBPROCESS_TIMEOUT_MS);
			child.stderr.on("data", (chunk) => errors.push(chunk));
			child.on("error", (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				rejectPromise(/* @__PURE__ */ new Error(`TURNREWIND_GIT_INIT: ${error.message}`));
			});
			child.on("close", (code, signal) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (!gitExitIsClean(code, signal)) {
					const detail = Buffer.concat(errors).toString("utf8").trim() || (signal ? `killed by ${signal}` : `exit ${code}`);
					const errorCode = signal ? "TURNREWIND_GIT_FAILED" : "TURNREWIND_GIT_INIT";
					rejectPromise(/* @__PURE__ */ new Error(`${errorCode}: ${detail}`));
					return;
				}
				resolvePromise();
			});
		});
		await runGitText(repoDir, workspaceDir, [
			"config",
			"core.autocrlf",
			"false"
		]);
		await runGitText(repoDir, workspaceDir, [
			"config",
			"core.symlinks",
			"true"
		]);
		await runGitText(repoDir, workspaceDir, [
			"config",
			"core.longpaths",
			"true"
		]);
		if (store.selfContained !== true) {
			const sourceObjects = join(sourceCommonDir, "objects");
			if (existsSync(sourceObjects)) {
				const alternates = join(repoDir, "objects", "info", "alternates");
				mkdirSync(dirname(alternates), { recursive: true });
				writeFileSync(alternates, `${sourceObjects}\n`);
			}
		}
	}
	if (sourceInfoExclude && existsSync(sourceInfoExclude)) {
		const exclude = join(repoDir, "info", "exclude");
		mkdirSync(dirname(exclude), { recursive: true });
		writeFileSync(exclude, readFileSync(sourceInfoExclude));
	}
}
function normalizeSnapshotRef(ref) {
	if (typeof ref !== "string" || !ref.startsWith(SNAPSHOT_REF_PREFIX) || ref.includes("..") || ref.includes(String.fromCharCode(92)) || ref.includes("//")) throw new Error(`TURNREWIND_REF_UNSUPPORTED: ${String(ref)}`);
	return ref;
}
/**
* P2-11: 所有插值进 git 参数的 commit/reffed 参数统一过校验——只接受
* `refs/turnrewind/*` ref 名或 40 位 SHA（gitRef/captureSnapshot 的返回
* 形态）。ledger 之外的取值在这里被拦下，而不是散落到各 git 子进程。
*/
function assertCommitRef(commit) {
	if (typeof commit !== "string" || !(commit.startsWith(SNAPSHOT_REF_PREFIX) || /^[0-9a-f]{40}$/.test(commit))) throw new Error(`TURNREWIND_REF_UNSUPPORTED: ${String(commit)}`);
	return commit;
}
async function gitRef(repoDir, workspaceDir, ref) {
	try {
		return (await runGitText(repoDir, workspaceDir, [
			"rev-parse",
			"--verify",
			normalizeSnapshotRef(ref)
		])).trim();
	} catch {
		return;
	}
}
function assertSafePath(workspaceDir, path) {
	const root = resolve(workspaceDir);
	const target = resolve(root, path);
	if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`TURNREWIND_PATH_ESCAPE: ${path}`);
	if (target === root) throw new Error(`TURNREWIND_PATH_ESCAPE: ${path} (workspace root cannot be restored)`);
	let current = root;
	const suffix = relative(root, target);
	for (const part of suffix.split(sep).filter(Boolean)) {
		current = join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) throw new Error(`TURNREWIND_SYMLINK_UNSUPPORTED: ${path}`);
		} catch (error) {
			if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
			throw error;
		}
	}
	return target;
}
/** Windows 路径分隔符（源码里避免裸控制字符，与 guard.ts 同一写法）。 */
const WINDOWS_PATH_SEPARATOR = String.fromCharCode(92);
/**
* Detect whether the volume holding `dir` folds case. macOS APFS is
* case-insensitive by default but can be formatted case-sensitive; on such
* volumes `Repo` and `repo` are distinct directories and must not collapse
* into one workspace key (the ledger/lock/snapshot domain would collide and
* a purge could delete the other workspace's state). The probe is cached per
* directory; unresolvable/synthetic paths fall back to the platform default
* so tests can keep passing without a real filesystem.
*/
const caseSensitivityCache = /* @__PURE__ */ new Map();
function isCaseInsensitiveDir(dir, platform) {
	const cached = caseSensitivityCache.get(dir);
	if (cached !== void 0) return cached;
	let result;
	try {
		const base = basename(dir);
		const parent = dirname(dir);
		const index = base.search(/[A-Za-z]/u);
		if (index === -1) result = platform === "darwin";
		else {
			const character = base[index];
			const toggled = character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
			const variant = join(parent, `${base.slice(0, index)}${toggled}${base.slice(index + 1)}`);
			const originalStat = lstatSync(dir);
			if (existsSync(variant)) {
				const variantStat = lstatSync(variant);
				result = originalStat.dev === variantStat.dev && originalStat.ino === variantStat.ino;
			} else result = false;
		}
	} catch {
		result = platform === "darwin";
	}
	caseSensitivityCache.set(dir, result);
	return result;
}
/**
* Canonical workspace identity shared by the ledger key, the snapshot repo
* hash, workspace locks and maintenance purges. `resolve()` alone is not an
* identity: the same directory is reachable under different spellings —
* macOS /var → /private/var (os.tmpdir lives behind that symlink) and
* Windows 8.3 short names (CI runners export TEMP as
* C:\Users\RUNNER~1\... while the on-disk name is runneradmin) — and one
* workspace must not split into two snapshot domains. realpathSync folds
* every spelling of an existing path onto its on-disk form, the same
* canonical spelling gitWorkspace reports for the worktree, so keys written
* from a raw cwd and keys computed from the probed worktree always agree;
* case-insensitive platforms (Windows NTFS, macOS APFS default) then fold
* casing so one directory cannot spawn two snapshot domains, and Linux
* stays byte-exact. Unresolvable paths (missing or unreadable) keep the
* resolved spelling so the key stays deterministic instead of throwing; a
* later call once the directory exists canonicalizes. `platform` remains
* injectable for tests.
*/
function workspaceKey(workspaceDir, platform = process.platform) {
	const normalized = resolve(workspaceDir);
	let canonical = normalized;
	try {
		const native = platform === "win32" ? normalized.replaceAll("/", WINDOWS_PATH_SEPARATOR) : normalized;
		canonical = resolve(realpathSync.native(native));
	} catch {}
	if (platform === "win32") return canonical.toLowerCase();
	if (platform === "darwin") return isCaseInsensitiveDir(canonical, platform) ? canonical.toLowerCase() : canonical;
	return canonical;
}
function workspaceHash(workspaceDir) {
	return createHash("sha256").update(workspaceKey(workspaceDir)).digest("hex").slice(0, 24);
}
/**
* Create one OpenCode-style private snapshot repository per Git worktree.
* The source Git directory is read-only metadata/object input; the snapshot
* repository keeps its own refs and alternate capture index.
*/
function createSnapshotStore(rootDir, workspaceDir) {
	const source = gitWorkspace(workspaceDir);
	if (!source) throw new Error(gitUnavailableReason() ?? `TURNREWIND_GIT_REQUIRED: ${resolve(workspaceDir)} is not a Git worktree`);
	const normalizedWorkspace = source.workspaceDir;
	return {
		rootDir,
		repoDir: join(rootDir, "snapshots", `${workspaceHash(normalizedWorkspace)}.git`),
		workspaceDir: normalizedWorkspace,
		sourceGitDir: source.gitDir,
		sourceCommonDir: source.commonDir,
		sourceIndexPath: source.indexPath,
		sourceInfoExclude: source.infoExcludePath ?? ""
	};
}
/**
* Git mode deliberately avoids a second full filesystem budget walk. The
* project's Git ignore rules determine the snapshot surface; restore keeps a
* per-file size limit because snapshot contents still have to fit in memory.
*/
function probeWorkspace(workspaceDir) {
	const source = gitWorkspace(workspaceDir);
	if (!source) return {
		ok: false,
		reason: gitUnavailableReason() ?? "TURNREWIND_GIT_REQUIRED: workspace is not a Git worktree"
	};
	return {
		ok: true,
		workspaceDir: source.workspaceDir,
		commonDir: source.commonDir
	};
}
/**
* Capture a snapshot, then verify every referenced object is still readable
* through the snapshot repository (including its alternates). The source
* repository can prune exactly the unreachable objects we borrowed —
* `git gc --prune=now` after an amend/rebase is the everyday case — so a
* capture that reuses a parent chain may silently reference deleted blobs.
* When that happens, rebuild the store as a self-contained repository (no
* alternates, no source-index seeding) and take a fresh baseline: old turns
* become dead snapshots the planner already skips, and future turns never
* borrow again.
*/
async function captureSnapshot(store, refName, message, parentRef) {
	let snapshot = await captureInto(store, refName, message, parentRef);
	if (await snapshotHasMissingObjects(store, snapshot.commit)) {
		console.warn(`turnrewind: snapshot objects for ${store.workspaceDir} disappeared from the source repository (gc/prune); rebuilding a self-contained baseline`);
		rmSync(store.repoDir, {
			recursive: true,
			force: true
		});
		store.selfContained = true;
		snapshot = await captureInto(store, refName, message, void 0);
		if (await snapshotHasMissingObjects(store, snapshot.commit)) throw new Error(`TURNREWIND_SNAPSHOT_INCOMPLETE: ${store.workspaceDir} baseline still misses objects after a self-contained rebuild`);
	}
	return snapshot;
}
/**
* `git rev-list --objects --missing=print` walks every object reachable from
* the commit (through alternates) and prints missing ones as `?<oid>` lines
* while exiting 0, so detection stays non-fatal on healthy stores.
*/
async function snapshotHasMissingObjects(store, commit) {
	try {
		return (await runGit(store.repoDir, store.workspaceDir, [
			"rev-list",
			"--objects",
			"--missing=print",
			commit
		])).toString("utf8").split("\n").some((line) => line.startsWith("?"));
	} catch (error) {
		console.warn(`turnrewind: snapshot connectivity check failed for ${store.workspaceDir}: ${error.message}`);
		return false;
	}
}
async function captureInto(store, refName, message, parentRef) {
	const { repoDir, workspaceDir, sourceIndexPath } = store;
	await ensureRepository(store);
	let parent;
	if (parentRef) {
		parent = await gitRef(repoDir, workspaceDir, parentRef);
		if (!parent) console.warn(`turnrewind: snapshot parent ${parentRef} is gone; building a fresh baseline for ${workspaceDir}`);
	}
	const indexPath = join(tmpdir(), `turnrewind-index-${randomUUID()}`);
	try {
		const env = { GIT_INDEX_FILE: indexPath };
		if (parent) await runGit(repoDir, workspaceDir, ["read-tree", parent], env);
		else if (store.selfContained !== true && existsSync(sourceIndexPath)) copyFileSync(sourceIndexPath, indexPath);
		await runGit(repoDir, workspaceDir, [
			"add",
			"--all",
			"--",
			".",
			...SNAPSHOT_PATHSPECS
		], env);
		const tree = (await runGit(repoDir, workspaceDir, ["write-tree"], env)).toString("utf8").trim();
		const identity = {
			GIT_AUTHOR_NAME: "DSH Turn Rewind",
			GIT_AUTHOR_EMAIL: "turnrewind@localhost",
			GIT_COMMITTER_NAME: "DSH Turn Rewind",
			GIT_COMMITTER_EMAIL: "turnrewind@localhost"
		};
		const args = [
			"commit-tree",
			tree,
			"-m",
			message
		];
		if (parent) args.push("-p", parent);
		const commit = (await runGit(repoDir, workspaceDir, args, {
			...env,
			...identity
		})).toString("utf8").trim();
		const ref = normalizeSnapshotRef(refName);
		await runGit(repoDir, workspaceDir, [
			"update-ref",
			ref,
			commit
		]);
		return {
			commit,
			refName: ref
		};
	} finally {
		rmSync(indexPath, { force: true });
	}
}
async function snapshotDiff(store, beforeCommit, afterCommit) {
	assertCommitRef(beforeCommit);
	assertCommitRef(afterCommit);
	const output = await runGit(store.repoDir, store.workspaceDir, [
		"diff",
		"--name-only",
		"-z",
		"--no-renames",
		beforeCommit,
		afterCommit
	]);
	return [...new Set(output.toString("utf8").split("\0").filter(Boolean))];
}
const DEFAULT_MAX_DIFF_LINES = 120;
function truncateDiff(text, maxLines = DEFAULT_MAX_DIFF_LINES) {
	const lines = text.replace(/\n$/u, "").split("\n");
	if (lines.length <= maxLines || lines[0] === "") return lines[0] === "" ? "" : lines.join("\n");
	return `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more line(s) truncated)`;
}
/** Classify how one path changed between two snapshots: created, deleted, or modified. */
async function classifyPathChange(store, beforeCommit, afterCommit, path) {
	const before = await stateAt(store, beforeCommit, path);
	const after = await stateAt(store, afterCommit, path);
	if (before.kind === "absent" && (after.kind === "file" || after.kind === "unsupported")) return "created";
	if ((before.kind === "file" || before.kind === "tooLarge" || before.kind === "unsupported") && after.kind === "absent") return "deleted";
	return "modified";
}
/** Unified diff of one path between two snapshot commits, truncated to maxLines. */
async function snapshotFileDiff(store, fromCommit, toCommit, path, maxLines) {
	assertCommitRef(fromCommit);
	assertCommitRef(toCommit);
	return truncateDiff((await runGit(store.repoDir, store.workspaceDir, [
		"diff",
		"--no-renames",
		"--ignore-cr-at-eol",
		fromCommit,
		toCommit,
		"--",
		path
	])).toString("utf8"), maxLines);
}
async function ensureEmptyBlob(store) {
	if (!store.emptyBlob) store.emptyBlob = (await runGitStdin(store.repoDir, store.workspaceDir, [
		"hash-object",
		"-w",
		"--stdin"
	], "")).toString("utf8").trim();
	return store.emptyBlob;
}
async function blobFor(store, commit, path) {
	if (!await commitEntryInfo(store, commit, path)) return ensureEmptyBlob(store);
	return (await runGit(store.repoDir, store.workspaceDir, ["rev-parse", `${commit}:${path}`])).toString("utf8").trim();
}
async function hashDiskFile(store, workspaceDir, path) {
	const target = assertSafePath(workspaceDir, path);
	if (!existsSync(target)) return ensureEmptyBlob(store);
	const info = lstatSync(target);
	if (!info.isFile() || info.size > MAX_FILE_BYTES) return void 0;
	return (await runGitStdin(store.repoDir, store.workspaceDir, [
		"hash-object",
		"-w",
		"--stdin"
	], await readFile(target))).toString("utf8").trim();
}
/**
* Unified diff between a path's committed state and its current on-disk content.
* Used to show what a human (or another session) changed after a turn, i.e. the
* content an undo would overwrite. The disk content is hashed into the private
* snapshot repo; the user's own repository is never touched.
*/
async function diffAgainstDisk(store, commit, path, maxLines) {
	assertCommitRef(commit);
	const from = await blobFor(store, commit, path);
	const to = await hashDiskFile(store, store.workspaceDir, path);
	if (to === void 0) return "(current file is not a regular file or exceeds the size limit)";
	if (from === to) return "";
	return truncateDiff((await runGit(store.repoDir, store.workspaceDir, [
		"diff",
		"--no-renames",
		"--ignore-cr-at-eol",
		"--src-prefix=snapshot/",
		"--dst-prefix=disk/",
		from,
		to
	])).toString("utf8"), maxLines);
}
async function commitEntryInfo(store, commit, path) {
	const output = await runGit(store.repoDir, store.workspaceDir, [
		"ls-tree",
		"-r",
		"-l",
		"-z",
		commit,
		"--",
		path
	]);
	for (const line of output.toString("utf8").split("\0")) {
		const tab = line.lastIndexOf("	");
		if (tab !== -1 && line.slice(tab + 1) === path) {
			const meta = line.slice(0, tab).split(" ");
			const size = Number(meta.at(-1));
			return {
				mode: meta[0] ?? "100644",
				type: meta[1] ?? "blob",
				size: Number.isFinite(size) && meta.at(-1) !== "-" ? size : void 0
			};
		}
	}
}
async function commitBytes(store, commit, path) {
	const output = await runGit(store.repoDir, store.workspaceDir, ["show", `${commit}:${path}`], {}, MAX_FILE_BYTES + 1);
	if (output.length > MAX_FILE_BYTES) throw new Error(`TURNREWIND_FILE_TOO_LARGE: ${path}`);
	return output;
}
function digest(bytes) {
	let comparable = bytes;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		comparable = new TextEncoder().encode(text.replaceAll("\r\n", "\n"));
	} catch {}
	return createHash("sha256").update(comparable).digest("hex");
}
async function stateAt(store, commit, path) {
	assertCommitRef(commit);
	const info = await commitEntryInfo(store, commit, path);
	if (!info) return {
		kind: "absent",
		digest: null
	};
	if (info.mode === GIT_SYMLINK_MODE || info.type === "commit") return {
		kind: "unsupported",
		digest: null
	};
	if ((info.size ?? 0) > MAX_FILE_BYTES) return {
		kind: "tooLarge",
		digest: null
	};
	return {
		kind: "file",
		digest: digest(await commitBytes(store, commit, path)),
		mode: info.mode
	};
}
async function currentState(workspaceDir, path) {
	const target = assertSafePath(workspaceDir, path);
	if (!existsSync(target)) return {
		kind: "absent",
		digest: null
	};
	const info = lstatSync(target);
	if (!info.isFile() || info.size > MAX_FILE_BYTES) return {
		kind: "unsupported",
		digest: null
	};
	const mode = process.platform === "win32" ? "100644" : `100${(info.mode & 511).toString(8).padStart(3, "0")}`;
	return {
		kind: "file",
		digest: digest(await readFile(target)),
		mode
	};
}
/**
* Remove one path, retrying briefly: Windows antivirus/indexers hold
* short-lived handles on freshly written files, and a transient EPERM/EBUSY
* on the .bak delete must not fail an otherwise successful restore.
*/
function rmSyncWithRetry(target, attempts = 5) {
	for (let attempt = 0;; attempt += 1) try {
		rmSync(target, { force: true });
		return;
	} catch (error) {
		const code = error?.code;
		if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < attempts) {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
			continue;
		}
		throw error;
	}
}
/**
* Crash-safe restore window. The pre-atomic sequence was delete-then-rename:
* a crash between those two steps left the target missing and its only copy
* in a .tmp file nobody resurrected. The swap keeps a complete copy on disk at
* every instant:
*
*   target -> target.turnrewind-restore.bak   (rename, atomic)
*   temp   -> target                          (rename, atomic)
*   bak    -> deleted                         (only after success)
*
* A crash anywhere leaves either the new content or the .bak; the startup
* sweep (restoreCrashedSwaps) resurrects a .bak whose target is missing.
*/
async function restorePath(store, commit, path) {
	assertCommitRef(commit);
	let target = assertSafePath(store.workspaceDir, path);
	const entry = await commitEntryInfo(store, commit, path);
	target = assertSafePath(store.workspaceDir, path);
	if (!entry) {
		if (existsSync(target)) {
			const info = lstatSync(target);
			if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path}`);
			if (info.isDirectory()) {
				if (readdirSync(target).length > 0) throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path} is now a non-empty directory; undo will not recursively delete it (remove it manually if intended)`);
				assertSafePath(store.workspaceDir, path);
				rmdirSync(target);
			} else {
				assertSafePath(store.workspaceDir, path);
				rmSync(target, { force: true });
			}
		}
		return {
			path,
			result: "removed"
		};
	}
	if (entry.mode === GIT_SYMLINK_MODE || entry.type === "commit") throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path} is a symlink or submodule in the snapshot; undo cannot restore it (recreate it manually if intended)`);
	if ((entry.size ?? 0) > MAX_FILE_BYTES) throw new Error(`TURNREWIND_FILE_TOO_LARGE: ${path} (${MAX_FILE_BYTES}-byte limit) cannot be restored; add it to .gitignore or restore it manually`);
	const bytes = await commitBytes(store, commit, path);
	target = assertSafePath(store.workspaceDir, path);
	mkdirSync(dirname(target), { recursive: true });
	const temp = `${target}.turnrewind-${randomUUID()}.tmp`;
	writeFileSync(temp, bytes, { flag: "wx" });
	chmodSync(temp, entry.mode === "100755" ? 493 : 420);
	let bak;
	try {
		if (existsSync(target)) {
			const info = lstatSync(target);
			if (info.isDirectory()) throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path} is a directory; undo will not delete it to restore a file`);
			if (info.isSymbolicLink() || !info.isFile()) throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path}`);
			bak = `${target}${BAK_SUFFIX}`;
			rmSync(bak, { force: true });
			assertSafePath(store.workspaceDir, path);
			renameSync(target, bak);
		}
		try {
			assertSafePath(store.workspaceDir, path);
			renameSync(temp, target);
		} catch (error) {
			if (bak !== void 0) try {
				if (!existsSync(target)) renameSync(bak, target);
				else rmSync(bak, { force: true });
			} catch {}
			throw error;
		}
		if (bak !== void 0) rmSyncWithRetry(bak);
	} catch (error) {
		rmSync(temp, { force: true });
		throw new Error(`TURNREWIND_RESTORE_FAILED: ${path}: ${error.message}`);
	}
	return {
		path,
		result: "restored"
	};
}
/**
* Startup sweep for atomic-swap leftovers. A .turnrewind-restore.bak next to
* a missing target means the process died between the two renames: resurrect
* the old content. A .bak next to an existing target is debris from a crash
* after the second rename (before the delete) - safe to remove. Returns the
* resurrected workspace-relative paths for logging.
*/
function restoreCrashedSwaps(workspaceDir) {
	const root = resolve(workspaceDir);
	const resurrected = [];
	const visit = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory() && entry.name !== ".git" && !entry.name.endsWith(BAK_SUFFIX)) {
				if (lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
				visit(full);
			}
			if (entry.isFile() && entry.name.endsWith(BAK_SUFFIX)) {
				const target = full.slice(0, -BAK_SUFFIX.length);
				for (let attempt = 0;; attempt += 1) try {
					if (!existsSync(target)) {
						renameSync(full, target);
						resurrected.push(relative(root, target));
					} else rmSync(full, { force: true });
					break;
				} catch (error) {
					const code = error?.code;
					if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < 5) {
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
						continue;
					}
					break;
				}
			}
		}
	};
	visit(root);
	return resurrected;
}

//#endregion
export { MAX_ROUTE_BODY_BYTES as C, SYNC_GIT_TIMEOUT_MS as E, MAX_FILE_BYTES as S, SNAPSHOT_REF_PREFIX as T, workspaceHash as _, diffAgainstDisk as a, gitWorkspace as b, gitRef as c, restorePath as d, runGit as f, stateAt as g, snapshotFileDiff as h, currentState as i, probeWorkspace as l, snapshotDiff as m, classifyPathChange as n, gitAvailable as o, runGitText as p, createSnapshotStore as r, gitExitIsClean as s, captureSnapshot as t, restoreCrashedSwaps as u, workspaceKey as v, PENDING_PLAN_TTL_MS as w, MAX_ENDED_TURNS as x, gitUnavailableReason as y };