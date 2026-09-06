/**
 * client/utils/heads-up.ts — 不可用工作区弹窗的「单会话一次」去重状态机。
 *
 * 纯函数：不依赖 DOM/localStorage。种子语义——首次观察到某个会话时，其
 * 投影里已存在的提示视为历史留档（会话内消息永久可见，不弹窗）；只有
 * 同一会话存活期间新到达的提示才上报一次。会话切换会重新播种。
 */

export interface HeadsUpNotice {
  id: string
  reason?: string
}

export interface HeadsUpTracker {
  observe: (currentSession: unknown, notices: HeadsUpNotice[]) => HeadsUpNotice[]
}

export function createHeadsUpTracker(): HeadsUpTracker {
  const knownIds = new Set<string>()
  let seededSession: unknown = null
  return {
    observe(currentSession, notices) {
      // 首次观察到当前会话（页面加载/切换会话）：现存提示全部视为已留档历史。
      if (seededSession !== currentSession) {
        seededSession = currentSession
        for (const notice of notices)
          knownIds.add(notice.id)
        return []
      }
      const fresh = notices.filter(notice => !knownIds.has(notice.id))
      for (const notice of fresh)
        knownIds.add(notice.id)
      return fresh
    },
  }
}

/**
 * 解析会话服务：优先走 compat 代理（其内部已按运行时形状做 get/属性双路
 * 读取），失败时回退原始 get('sessions')。两路都要求 list.getSnapshot/
 * subscribe 形状完整——形状不符宁可返回 undefined 并让调用方告警，也不
 * 静默让弹窗链路失效（审计报告 P2-8）。
 */
export interface SessionsLike {
  list: {
    getSnapshot: () => unknown
    subscribe: (fn: () => void) => () => void
  }
}

export function resolveSessionsService(candidates: Array<unknown>): SessionsLike | undefined {
  for (const candidate of candidates) {
    const sessions = candidate as SessionsLike | undefined | null
    if (sessions && typeof sessions.list?.getSnapshot === 'function' && typeof sessions.list?.subscribe === 'function')
      return sessions
  }
  return undefined
}
