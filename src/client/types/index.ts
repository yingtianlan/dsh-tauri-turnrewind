/**
 * client/types/index.ts — 客户端共享类型。
 */

import type { LocaleKey } from '../locales'

export type { LocaleKey } from '../locales'

/** 卡片里单个文件条目（解析 /undo 预览输出得到）。 */
export interface ParsedUndoFile {
  path: string
  change: 'modified' | 'created' | 'deleted' | 'conflict'
  additions: number
  deletions: number
  diff: string[]
  conflict: boolean
}

/** /undo 输出的解析结果（summary / 文件清单 / diff 分隔 / plan id）。 */
export interface ParsedUndoOutput {
  summary: string
  files: ParsedUndoFile[]
  dividers: string[]
  planId: string | undefined
}

/** plan 状态轮询结果。 */
export interface PlanStatusResolution {
  status: 'pending' | 'applied' | 'cancelled' | 'expired' | 'gone' | 'error' | null
  stop: boolean
  resultText: string | null
}

/** /undo 命令卡片槽位组件的 props（P2-10：集中到 client/types）。 */
export interface CommandViewProps {
  node?: { id?: string, name?: string, sessionId?: string, outcome?: { kind?: string, text?: string } }
  sessionId?: string
}

/** locale 取词函数：apply 装配层按当前活跃语言注入，组件层消费。 */
export type Translate = (key: LocaleKey) => string

/** 恢复面板行（host GET /api/turnrewind/recovery 的 workspaces 条目）。 */
export interface RecoveryWorkspaceInfo {
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
