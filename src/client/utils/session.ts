/**
 * client/utils/session.ts — 卡片宿主会话解析（纯函数）。
 */

export function resolveOwnerSessionId(props: { sessionId?: unknown, node?: { sessionId?: unknown } } | undefined): string | null {
  const candidates = [props?.sessionId, props?.node?.sessionId]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0)
      return candidate
  }
  return null
}
