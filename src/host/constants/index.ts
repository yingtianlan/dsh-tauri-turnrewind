/**
 * host/constants/index.ts — 宿主侧私有常量。
 */

/** 单文件快照/恢复上限（64 MiB；blob 超限单文件报告，不炸整体 undo）。 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024

/** git 子进程输出上限。 */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** 异步 git 子进程墙钟预算（SIGKILL 兜底）。 */
export const GIT_SUBPROCESS_TIMEOUT_MS = 5 * 60 * 1000

/** 可用性探测预算（探测喂给 pre-step barrier，挂起即卡 turn）。 */
export const GIT_PROBE_TIMEOUT_MS = 30 * 1000

/** 可用性探测失败后的重试间隔。 */
export const GIT_PROBE_RETRY_MS = 5 * 60 * 1000

/** 同步 rev-parse 的预算（本地元数据查询，慢于此即视为卡死）。 */
export const SYNC_GIT_TIMEOUT_MS = 15 * 1000

/** 快照 refs 允许的前缀（拒绝其他 refs 命名空间与路径穿越）。 */
export const SNAPSHOT_REF_PREFIX = 'refs/turnrewind/'

/** Git symlink 条目的 mode 值（P1-3：stateAt/restore 据此拒绝，而非伪装成文件）。 */
export const GIT_SYMLINK_MODE = '120000'

/** 原子替换的 bak 后缀。 */
export const BAK_SUFFIX = '.turnrewind-restore.bak'

/** 快照排除规则（git pathspec；ignore 语义委托源仓库）。 */
export const SNAPSHOT_PATHSPECS: string[] = [
  ':(exclude,glob).git/**',
  ':(exclude,glob)**/.git/**',
  ':(exclude,glob).turnrewind/**',
  ':(exclude,glob)**/.turnrewind/**',
  ':(exclude,glob)**/*.turnrewind-*.tmp',
  ':(exclude,glob)**/*.turnrewind-restore.bak',
]

/** pending plan 存活时长（只影响未执行的预览；settled 结果行永久保留可追溯）。 */
export const PENDING_PLAN_TTL_MS = 5 * 60 * 1000

/** endedTurns 内存上界。 */
export const MAX_ENDED_TURNS = 500

/** HTTP 路由 body 上限。 */
export const MAX_ROUTE_BODY_BYTES = 16 * 1024
