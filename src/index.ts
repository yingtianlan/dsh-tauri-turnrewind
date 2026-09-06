/**
 * dsh-tauri-turnrewind 宿主侧（node half）：turn 级工作区撤销（Git 目录快照模式）。
 *
 * 三层目录（host / client / shared）：
 *   - index.ts（本文件）     public barrel：只保留导出面（name/inject/apply/领域能力）；
 *   - shared/constants.ts    跨 half 协议常量（插件名 / API 前缀 / storage 基名）；
 *   - host/                  Node half（apply 装配 / service 领域 / routes HTTP 路由）；
 *   - client/                Browser half（两阶段 undo 卡片 / 不可用弹窗 / 轮询）。
 *
 * 模型（OpenCode 式 Git 目录快照）：
 *   1. 会话 cwd 必须位于 Git worktree（子目录归并到根；非 Git 记 skipped）；
 *   2. 每个工作区一个私有 snapshot repo（$DSH_HOME/snapshots/<hash>.git），经
 *      alternates 借用源仓库对象；ignore 语义委托源仓库；
 *   3. turn 开始前 barrier 拍 before 快照，turn/end 后拍 after 快照；
 *   4. /undo 两阶段：预览卡（红绿 diff）→ ✓（经 /api/turnrewind/confirm）→ 恢复；
 *   5. 恢复是原子 bak-swap；崩溃窗口由启动清扫复活；绝不触碰用户 HEAD/index。
 */

export { apply, inject, name, turnSnapshotRef, waitForTurnBaseline } from './host/apply'
export { jsonRoute } from './host/routes'
export { createDialogProjection } from './host/service/dialog-projection'
export {
  captureSnapshot,
  createSnapshotStore,
  currentState,
  gitAvailable,
  gitExitIsClean,
  gitRef,
  probeWorkspace,
  restoreCrashedSwaps,
  restorePath,
  runGit,
  snapshotDiff,
  snapshotFileDiff,
  stateAt,
  workspaceHash,
  workspaceKey,
} from './host/service/git-snapshot'
export { gitUnavailableReason, gitWorkspace } from './host/service/git-workspace'
export { isSystemSensitiveWorkspace } from './host/service/guard'
export { openLedger } from './host/service/ledger'
export { purgeWorkspace, resolveRootDir } from './host/service/maintenance'
export { classifyUndo } from './host/service/planner'
export { enforceRetention } from './host/service/retention'
export { applyUndo, buildPlanEntries, executeUndoRestore, formatPlan, parseUndoInput, turnRefsExist } from './host/service/undo'
export { acquireWorkspaceLock, acquireWorkspaceLockSync, withWorkspaceLock, WorkspaceLockBusyError } from './host/service/workspace-lock'
export { TURNREWIND_API_PREFIX, TURNREWIND_PLUGIN_NAME, TURNREWIND_STORAGE_BASE } from './shared/constants'
