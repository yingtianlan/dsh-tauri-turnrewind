import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";

//#region src/host/types/index.d.ts

/** 快照仓库句柄：一个 Git worktree 对应一个私有 snapshot repo。 */
interface SnapshotStore {
  /** 数据根目录（$DSH_HOME），workspace 锁文件的定位依赖它。 */
  rootDir: string;
  repoDir: string;
  workspaceDir: string;
  sourceGitDir: string;
  sourceCommonDir: string;
  sourceIndexPath: string;
  sourceInfoExclude: string;
  /** 自愈降级后为 true：不再写 alternates、不再复制源 index。 */
  selfContained?: boolean;
  /** empty blob 缓存（hash-object 惰性写入后复用）。 */
  emptyBlob?: string;
}
/** 一次 capture 的结果：commit id + 规范化后的 ref 名。 */
interface Snapshot {
  commit: string;
  refName: string;
}
/** 文件在某个快照提交里的状态。mode 为 git 条目 mode（'100644'/'100755'）。 */
type PathState = {
  kind: 'absent';
  digest: null;
} | {
  kind: 'file';
  digest: string;
  mode: string;
} | {
  kind: 'tooLarge';
  digest: null;
} | {
  kind: 'unsupported';
  digest: null;
};
/** 磁盘当前状态（conflict 检测用）。 */
type DiskState = PathState;
/** 路径在 turn 内的变化分类。 */
type PathChange = 'created' | 'deleted' | 'modified';
/** 恢复单路径的结果。 */
type RestoreResult = {
  path: string;
  result: 'restored';
} | {
  path: string;
  result: 'removed';
};
/** 工作区资格探测结果。 */
interface WorkspaceProbe {
  ok: boolean;
  workspaceDir?: string;
  commonDir?: string;
  reason?: string;
}
/** git rev-parse 解析出的源仓库元数据。 */
interface GitWorkspaceInfo {
  workspaceDir: string;
  requestedDir: string;
  gitDir: string;
  commonDir: string;
  indexPath: string;
  infoExcludePath: string | undefined;
}
/** undo 计划的单路径条目。 */
interface PlanEntry {
  path: string;
  change: PathChange;
  conflict: boolean;
  /** before 快照超限：恢复会失败并计入未恢复清单。 */
  tooLarge: boolean;
  /** before 快照中的条目不可恢复（symlink 等）：恢复会跳过并计入未恢复清单。 */
  unsupported: boolean;
}
/** /undo 命令解析结果（confirm/cancel 为标志；plan id 或 turn id 落在 turnId）。 */
interface UndoInput {
  turnId?: string;
  dryRun?: boolean;
  preview?: boolean;
  skipConflicts?: boolean;
  force?: boolean;
  redo?: boolean;
  confirm?: boolean;
  cancel?: boolean;
  /** 只读诊断：/undo --doctor（不能与其他选项组合）。 */
  doctor: boolean;
}
//#endregion
//#region src/host/service/ledger.d.ts
interface TurnRow {
  turn_id: string;
  session_id: string;
  parent_turn_id: string | null;
  workspace_key: string;
  status: string;
  started_at: string;
  settled_at: string | null;
  before_ref: string | null;
  after_ref: string | null;
  reversible: number;
  error: string | null;
}
type Ledger = DatabaseSync;
declare function openLedger(rootDir: string): Ledger;
//#endregion
//#region src/host/service/undo.d.ts

interface WorkspaceRuntime {
  db: Ledger;
  store: SnapshotStore;
  workspaceKey: string;
  workspaceDir: string;
  parentRef: string | undefined;
  undoing: boolean;
  disposed: boolean;
}
interface UndoInvocation {
  rawInput: string;
  agent: {
    session: {
      id: string;
      header?: {
        cwd?: string;
      };
    };
  };
}
interface UndoOutcome {
  kind: 'success' | 'error';
  text: string;
}
/** 解析 /undo 的输入行（turn id / 预览与冲突策略 / 两阶段 confirm/cancel / 诊断）。 */
declare function parseUndoInput(rawInput: string): UndoInput | {
  error: string;
};
/**
 * 构建只读 undo 计划：每个路径的变化分类、磁盘是否仍匹配 turn 后快照、
 * before 快照是否超限（超限条目恢复时单文件失败，绝不静默）。
 */
declare function buildPlanEntries(runtime: WorkspaceRuntime, workspaceDir: string, target: TurnRow, paths: string[]): Promise<PlanEntry[]>;
interface PlanFormatOptions {
  preview?: boolean;
  dryRun?: boolean;
  withDiffs?: boolean;
}
declare function formatPlan(runtime: WorkspaceRuntime, target: TurnRow, entries: PlanEntry[], options: PlanFormatOptions): Promise<string>;
/** 共享 undo 执行器（命令路径与确认 HTTP 路由共用）。 */
declare function executeUndoRestore(runtime: WorkspaceRuntime, params: {
  sessionId: string;
  workspaceKey: string;
  target: TurnRow;
  paths: string[];
  entries: PlanEntry[];
  skipConflicts?: boolean;
}): Promise<string>;
declare function turnRefsExist(store: SnapshotStore, turn: TurnRow): Promise<boolean>;
interface WorkspaceEnv {
  workspaceForAgent: (agent: {
    session: {
      header?: {
        cwd?: string;
      };
    };
  }) => string | undefined;
  workspaceIssue: (dir: string) => string | undefined;
  workspaceKeyFor: (path: string) => string;
}
declare function applyUndo(runtime: WorkspaceRuntime, active: Map<string, unknown>, invocation: UndoInvocation, env?: WorkspaceEnv): Promise<UndoOutcome>;
//#endregion
//#region src/host/apply.d.ts
/** 插件名（诊断元数据，与 shared/constants 的 TURNREWIND_PLUGIN_NAME 一致）。 */
declare const name = "dsh-tauri-turnrewind";
/**
 * 需要的宿主服务：
 *   commands             /undo 人类命令
 *   sessionProjections   不可用弹窗的会话投影
 *   webServer            /api/turnrewind/*（卡内 ✓/✗ 与状态轮询）
 */
declare const inject: readonly ["commands", "sessionProjections", "webServer"];
interface HostApplyContext {
  commands: {
    register: (command: unknown) => () => void;
  };
  sessionProjections: {
    register: (projection: unknown) => () => void;
  };
  webServer: {
    register: (route: unknown) => () => void;
  };
  on: (event: string, listener: (...args: any[]) => void) => void;
  effect: (factory: () => (() => void) | void, label?: string) => () => void;
  logger?: {
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}
interface ActiveEntry {
  runtime: WorkspaceRuntime;
  sessionId: string;
  workspaceKey: string;
  turnId: string;
  beforeRef: string;
  baseline: Deferred;
  baselineReady: boolean;
  startedAt: string;
  turn: number;
}
interface Deferred {
  promise: Promise<{
    ok: boolean;
    reason?: string;
  }>;
  resolve: (value: {
    ok: boolean;
    reason?: string;
  }) => void;
}
/** turn 前后快照 ref：turnId 的 sha256 前 32 位 + 阶段后缀，稳定且不进用户 refs 命名空间。 */
declare function turnSnapshotRef(turnId: string, phase: string): string;
declare function waitForTurnBaseline(activeTurns: Map<string, ActiveEntry>, sessionId: string, turn: number, signal?: AbortSignal): Promise<{
  ok: boolean;
  reason?: string;
} | undefined>;
declare function apply(ctx: HostApplyContext): void;
//#endregion
//#region src/host/routes/index.d.ts
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
interface RouteRequest {
  method?: string;
  url?: string;
  socket?: {
    remoteAddress?: string;
  };
  headers?: Record<string, string | string[] | undefined>;
  on: (event: string, listener: (...args: any[]) => void) => void;
  destroy?: (error?: Error) => void;
  setHeader?: (name: string, value: string) => void;
}
interface RouteResponse {
  writeHead: (code: number, headers: Record<string, string>) => void;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
}
type RouteHandler = (body: Record<string, unknown>, req: RouteRequest) => Promise<[number, unknown]> | [number, unknown];
interface WebRoute {
  kind: 'exact';
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => void;
}
interface JsonRouteOptions {
  mutate?: boolean;
  /** 允许的 HTTP 方法（大写）。缺省不限制；mutate 路由隐式限定 POST。 */
  methods?: string[];
  /**
   * 处理超时（ms）。默认 120s；超时后返回 504，服务端逻辑继续执行，
   * 客户端经 status 轮询恢复结果。
   */
  timeoutMs?: number;
}
declare function jsonRoute(path: string, handler: RouteHandler, {
  mutate,
  methods,
  timeoutMs
}?: JsonRouteOptions): WebRoute;
//#endregion
//#region src/host/service/dialog-projection.d.ts
interface UnsupportedNotice {
  id: string;
  reason: string;
}
interface ProjectionState {
  notices: UnsupportedNotice[];
}
declare function parseNoticesValue(value: unknown): ProjectionState;
/**
 * Build the `turnrewind` projection unit. Registered on `ctx.sessionProjections`;
 * the registry requires `.parse` validators — hand-rolled ones keep this plugin
 * dependency-free.
 */
declare function createDialogProjection(): {
  key: string;
  stateVersion: number;
  stateSchema: {
    parse: typeof parseNoticesValue;
  };
  init: () => ProjectionState;
  apply(state: ProjectionState, event: unknown): ProjectionState;
  wire: {
    viewSchema: {
      parse: typeof parseNoticesValue;
    };
    view: (state: ProjectionState) => {
      notices: UnsupportedNotice[];
    };
  };
};
//#endregion
//#region src/host/service/git-snapshot.d.ts
/** 退出判定：只有干净退出（code 0、无信号）才可 resolve。 */
declare function gitExitIsClean(code: number | null, signal: NodeJS.Signals | null): boolean;
/**
 * 异步执行一条 git 命令（不阻塞事件循环）。SIGKILL 预算防卡死；外部击杀
 * （close(null, signal) 且非自身超时）reject——resolve 半截输出会把残缺 index
 * 提交成 turn 快照。
 */
declare function runGit(repoDir: string, workspaceDir: string, args: string[], extraEnv?: Record<string, string>, maxBytes?: number): Promise<Buffer>;
/**
 * PATH 上是否有可用的 git。成功探测进程级缓存；失败探测按 GIT_PROBE_RETRY_MS
 * 过期重试（进程内装好 git/修好 PATH 无需重启 Host）。探测喂给 pre-step barrier，
 * 无预算挂起的 `git --version` 会永远卡住 turn。
 */
declare function gitAvailable(): Promise<boolean>;
declare function gitRef(repoDir: string, workspaceDir: string, ref: string): Promise<string | undefined>;
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
declare function workspaceKey(workspaceDir: string, platform?: string): string;
declare function workspaceHash(workspaceDir: string): string;
/**
 * Create one OpenCode-style private snapshot repository per Git worktree.
 * The source Git directory is read-only metadata/object input; the snapshot
 * repository keeps its own refs and alternate capture index.
 */
declare function createSnapshotStore(rootDir: string, workspaceDir: string): SnapshotStore;
/**
 * Git mode deliberately avoids a second full filesystem budget walk. The
 * project's Git ignore rules determine the snapshot surface; restore keeps a
 * per-file size limit because snapshot contents still have to fit in memory.
 */
declare function probeWorkspace(workspaceDir: string): WorkspaceProbe;
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
declare function captureSnapshot(store: SnapshotStore, refName: string, message: string, parentRef?: string): Promise<Snapshot>;
declare function snapshotDiff(store: SnapshotStore, beforeCommit: string, afterCommit: string): Promise<string[]>;
/** Unified diff of one path between two snapshot commits, truncated to maxLines. */
declare function snapshotFileDiff(store: SnapshotStore, fromCommit: string, toCommit: string, path: string, maxLines?: number): Promise<string>;
declare function stateAt(store: SnapshotStore, commit: string, path: string): Promise<PathState>;
declare function currentState(workspaceDir: string, path: string): Promise<DiskState>;
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
declare function restorePath(store: SnapshotStore, commit: string, path: string): Promise<RestoreResult>;
/**
 * Startup sweep for atomic-swap leftovers. A .turnrewind-restore.bak next to
 * a missing target means the process died between the two renames: resurrect
 * the old content. A .bak next to an existing target is debris from a crash
 * after the second rename (before the delete) - safe to remove. Returns the
 * resurrected workspace-relative paths for logging.
 */
declare function restoreCrashedSwaps(workspaceDir: string): string[];
//#endregion
//#region src/host/service/git-workspace.d.ts
/** git 不在 PATH 时报告真实原因（否则会把正常 worktree 误报为非 worktree）。 */
declare function gitUnavailableReason(): string | undefined;
declare function gitWorkspace(workspaceDir: string): GitWorkspaceInfo | undefined;
//#endregion
//#region src/host/service/guard.d.ts
/**
 * host/service/guard.ts — 系统目录工作区拒绝（家目录/祖先/盘根）。
 *
 * Git 目录模式不再做全目录预算扫描：Git ignore 语义决定快照面，本守卫只保留
 * 「绝不可快照」的系统目录判定。pathe 输出正斜杠而宿主 cwd 可能带反斜杠，
 * 比较前统一归一化分隔符；pathe 对「已绝对的盘根」（resolve('C:/') → '/C:'）
 * 有怪输出，normalize 前先把裸盘符恢复成盘根形态。
 */
declare function isSystemSensitiveWorkspace(workspaceDir: string): boolean;
//#endregion
//#region src/host/service/maintenance.d.ts
/**
 * host/service/maintenance.ts — 工作区级 turnrewind 数据清除。
 *
 * 只删除本插件自己的 snapshot repo 与账本行；用户 .git、工作区文件与其他
 * workspace 的数据绝不触碰（maintenance.test 钉死）。
 */
declare function resolveRootDir(explicit?: string): string;
interface PurgeSummary {
  rootDir: string;
  repoDir: string;
  repoExisted: boolean;
  ledger?: {
    operations: number;
    notices: number;
    plans: number;
    turns: number;
    workspaces: number;
  };
}
/**
 * Remove every piece of turnrewind data bound to one workspace: the private
 * snapshot repository on disk and all ledger rows that reference it.
 *
 * 跨进程互斥（P1-1）：purge 是破坏性维护操作，与运行中的 Host（快照捕获、
 * undo 等）互斥；workspace 被占用时直接抛 WorkspaceLockBusyError，由 CLI
 * 提示先停止 Host 再执行。
 */
declare function purgeWorkspace(rootDir: string, workspaceDir: string): PurgeSummary;
//#endregion
//#region src/host/service/planner.d.ts
declare function classifyUndo(current: DiskState, expected: PathState): 'safe' | 'conflict';
//#endregion
//#region src/host/service/retention.d.ts
interface RetentionOptions {
  retainTurns?: number;
  maxSnapshotMb?: number;
}
interface RetentionResult {
  /** 因超出保留条数被标记过期的 turn 数。 */
  expiredByCount: number;
  /** 因仓库超限被重建（true 时该 workspace 全部可撤销 turn 同时过期）。 */
  rebuilt: boolean;
  /** 重建/过期时一并标记的 turn 数（含 expiredByCount 之外的部分）。 */
  expiredByRebuild: number;
  /** 快照仓库当前占用（MB，重建前测量）。 */
  repoSizeMb: number;
}
/**
 * 对一个 workspace 执行容量治理。在无活动 turn / 无 undo 的安全点调用
 * （当前唯一调用点：ensureRuntime 的 workspace 首次触碰，调用方持跨进程
 * workspace 锁）。
 */
declare function enforceRetention(db: Ledger, store: SnapshotStore, options?: RetentionOptions): RetentionResult;
//#endregion
//#region src/host/service/workspace-lock.d.ts
interface LockContent {
  pid: number;
  token: string;
  acquiredAt: string;
  host: string;
}
declare class WorkspaceLockBusyError extends Error {
  constructor(workspaceDir: string, holder?: LockContent);
}
interface WorkspaceLockHandle {
  release: () => void;
}
/** 异步获取：waitMs 内按 100ms 步长忙等；超时或竞态余量耗尽抛 WorkspaceLockBusyError。 */
declare function acquireWorkspaceLock(rootDir: string, workspaceDir: string, {
  waitMs
}?: {
  waitMs?: number;
}): Promise<WorkspaceLockHandle>;
/** 同步获取（purge CLI 等 offline 工具）：只尝试一次，忙即抛错。 */
declare function acquireWorkspaceLockSync(rootDir: string, workspaceDir: string): WorkspaceLockHandle;
/** 在 workspace 锁内执行异步工作：获取失败抛 WorkspaceLockBusyError，成功后保证释放。 */
declare function withWorkspaceLock<T>(rootDir: string, workspaceDir: string, work: () => Promise<T>, {
  waitMs
}?: {
  waitMs?: number;
}): Promise<T>;
//#endregion
//#region src/shared/constants.d.ts
/**
 * shared/constants.ts — 跨 host/client 的稳定协议常量。
 *
 * API 前缀与插件名是两半端共享的线协议面：host 路由注册、client RPC 各自硬编码
 * 会漂移，集中在此由两端共同引用。
 */
/** 插件名（诊断元数据 / registrant / storage key 前缀）。 */
declare const TURNREWIND_PLUGIN_NAME = "dsh-tauri-turnrewind";
/** HTTP 路由前缀（host route + client rpc 同源 fetch）。 */
declare const TURNREWIND_API_PREFIX = "/api/turnrewind";
/** 弹窗去重的 localStorage 基名（不带冒号，driver 侧拼前缀）。 */
declare const TURNREWIND_STORAGE_BASE = "dsh-tauri-turnrewind";
//#endregion
export { TURNREWIND_API_PREFIX, TURNREWIND_PLUGIN_NAME, TURNREWIND_STORAGE_BASE, WorkspaceLockBusyError, acquireWorkspaceLock, acquireWorkspaceLockSync, apply, applyUndo, buildPlanEntries, captureSnapshot, classifyUndo, createDialogProjection, createSnapshotStore, currentState, enforceRetention, executeUndoRestore, formatPlan, gitAvailable, gitExitIsClean, gitRef, gitUnavailableReason, gitWorkspace, inject, isSystemSensitiveWorkspace, jsonRoute, name, openLedger, parseUndoInput, probeWorkspace, purgeWorkspace, resolveRootDir, restoreCrashedSwaps, restorePath, runGit, snapshotDiff, snapshotFileDiff, stateAt, turnRefsExist, turnSnapshotRef, waitForTurnBaseline, withWorkspaceLock, workspaceHash, workspaceKey };