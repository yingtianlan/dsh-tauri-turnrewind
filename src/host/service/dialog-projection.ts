/**
 * host/service/dialog-projection.ts — `turnrewind` 会话投影。
 *
 * 把插件注入的 unsupported-workspace heads-up 消息折叠进会话列表快照，客户端半
 * 据此弹窗。纯函数、单测覆盖；index.ts 的注册是唯一 effect。
 */

export const UNSUPPORTED_MARKER = '[Turn rewind unavailable]'

const MAX_TRACKED_NOTICES = 20

export interface UnsupportedNotice {
  id: string
  reason: string
}

export interface ProjectionState {
  notices: UnsupportedNotice[]
}

/** 提取一条 user/message 事件里的 heads-up 负载（按插件 source 匹配，文本标记兜底）。 */
export function extractUnsupportedNotice(event: unknown): UnsupportedNotice | undefined {
  const candidate = event as { type?: string, data?: { content?: unknown, id?: unknown, source?: { plugin?: string, form?: string } } } | undefined
  if (candidate?.type !== 'user/message')
    return undefined
  const message = candidate.data
  const text = Array.isArray(message?.content)
    ? (message.content as { type?: string, text?: string }[]).find(part => part?.type === 'text')?.text
    : undefined
  const source = message?.source
  const matched = (source?.plugin === 'dsh-tauri-turnrewind' && source?.form === 'undo-unavailable-notice')
    || (typeof text === 'string' && text.startsWith(UNSUPPORTED_MARKER))
  if (!matched || typeof message?.id !== 'string')
    return undefined
  const reason = typeof text === 'string' ? /^Reason: (.+)$/mu.exec(text)?.[1] : undefined
  return { id: message.id, reason: reason ?? '' }
}

function parseNoticesValue(value: unknown): ProjectionState {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as ProjectionState).notices))
    throw new Error('TURNREWIND_PROJECTION_SHAPE: expected { notices: Array<{ id, reason }> }')
  return value as ProjectionState
}

/**
 * Build the `turnrewind` projection unit. Registered on `ctx.sessionProjections`;
 * the registry requires `.parse` validators — hand-rolled ones keep this plugin
 * dependency-free.
 */
export function createDialogProjection() {
  return {
    key: 'turnrewind',
    stateVersion: 1,
    stateSchema: { parse: parseNoticesValue },
    init: (): ProjectionState => ({ notices: [] }),
    apply(state: ProjectionState, event: unknown): ProjectionState {
      const notice = extractUnsupportedNotice(event)
      if (!notice || state.notices.some(existing => existing.id === notice.id))
        return state
      return { notices: [...state.notices, notice].slice(-MAX_TRACKED_NOTICES) }
    },
    wire: {
      viewSchema: { parse: parseNoticesValue },
      view: (state: ProjectionState) => ({ notices: state.notices }),
    },
  }
}
