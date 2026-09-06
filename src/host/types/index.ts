/**
 * host/types/index.ts — 宿主侧共享类型。
 *
 * SQLite 账本行、快照状态与 Git 子进程结果的形状集中在 barrel；跨文件协议
 * （pending plan、undo 结果）也在此定义，组件/服务文件不得重复声明。
 */

export type HostContext = any

/** 快照仓库句柄：一个 Git worktree 对应一个私有 snapshot repo。 */
export interface SnapshotStore {
  /** 数据根目录（$DSH_HOME），workspace 锁文件的定位依赖它。 */
  rootDir: string
  repoDir: string
  workspaceDir: string
  sourceGitDir: string
  sourceCommonDir: string
  sourceIndexPath: string
  sourceInfoExclude: string
  /** 自愈降级后为 true：不再写 alternates、不再复制源 index。 */
  selfContained?: boolean
  /** empty blob 缓存（hash-object 惰性写入后复用）。 */
  emptyBlob?: string
}

/** 一次 capture 的结果：commit id + 规范化后的 ref 名。 */
export interface Snapshot {
  commit: string
  refName: string
}

/** 文件在某个快照提交里的状态。mode 为 git 条目 mode（'100644'/'100755'）。 */
export type PathState
  = | { kind: 'absent', digest: null }
    | { kind: 'file', digest: string, mode: string }
    | { kind: 'tooLarge', digest: null }
    | { kind: 'unsupported', digest: null }

/** 磁盘当前状态（conflict 检测用）。 */
export type DiskState = PathState

/** 路径在 turn 内的变化分类。 */
export type PathChange = 'created' | 'deleted' | 'modified'

/** 恢复单路径的结果。 */
export type RestoreResult
  = | { path: string, result: 'restored' }
    | { path: string, result: 'removed' }

/** 工作区资格探测结果。 */
export interface WorkspaceProbe {
  ok: boolean
  workspaceDir?: string
  commonDir?: string
  reason?: string
}

/** git rev-parse 解析出的源仓库元数据。 */
export interface GitWorkspaceInfo {
  workspaceDir: string
  requestedDir: string
  gitDir: string
  commonDir: string
  indexPath: string
  infoExcludePath: string | undefined
}

/** undo 计划的单路径条目。 */
export interface PlanEntry {
  path: string
  change: PathChange
  conflict: boolean
  /** before 快照超限：恢复会失败并计入未恢复清单。 */
  tooLarge: boolean
  /** before 快照中的条目不可恢复（symlink 等）：恢复会跳过并计入未恢复清单。 */
  unsupported: boolean
}

/** /undo 命令解析结果（confirm/cancel 为标志；plan id 或 turn id 落在 turnId）。 */
export interface UndoInput {
  turnId?: string
  dryRun?: boolean
  preview?: boolean
  skipConflicts?: boolean
  force?: boolean
  redo?: boolean
  confirm?: boolean
  cancel?: boolean
  /** 只读诊断：/undo --doctor（不能与其他选项组合）。 */
  doctor: boolean
}

/** 命令/路由共用的执行结果形状。 */
export interface UndoOutcome {
  kind: 'success' | 'error'
  text: string
}
