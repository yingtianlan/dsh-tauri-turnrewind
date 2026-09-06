/**
 * dsh-tauri-turnrewind 客户端插件体（browser half）：两阶段 undo 卡片与不可用弹窗。
 *
 * 目录规划：constants/ types/ utils/（纯函数）locales/（双语）register/
 * （卡片/弹窗注册）/ components/（React 组件）；与 node half（host/）经
 * /api/turnrewind/* 通信。
 */

import type { ClientContext } from 'dsh-tauri/client'
import type { LocaleKey } from './locales'
import { compat, createLifecycleController } from 'dsh-tauri/client'
import { setCardTranslator, setSubmitLine } from './components/command-view'
import { TURNREWIND_HTTP_BASE, TURNREWIND_LOCALE_NS, TURNREWIND_POLL_INTERVAL_MS, TURNREWIND_POLL_STOP_MS } from './constants'
import { LOCALES } from './locales'
import { registerCommandView } from './register/command-view'
import { disposeDialog, listNotices, setRecoveryOpener, showDialog } from './register/dialog'
import { disposeRecoveryDialog, openRecoveryDialog } from './register/recovery'
import { mountCommandViewStyles, mountDialogStyles, mountRecoveryStyles } from './styles'
import { createHeadsUpTracker, resolveSessionsService } from './utils/heads-up'
import { parseUndoOutput, resolvePlanStatus } from './utils/parse'
import { resolveOwnerSessionId } from './utils/session'

export { TURNREWIND_API_PREFIX } from '../shared/constants'
export type { LocaleKey, ParsedUndoFile, ParsedUndoOutput, PlanStatusResolution } from './types'
export { parseUndoOutput, resolveOwnerSessionId, resolvePlanStatus }

/** 插件显示名（诊断元数据）。 */
export const name = 'dsh-tauri-turnrewind'

/** 需要的客户端服务：slots（卡片点位）、sessions（状态轮询/弹窗）、locale（双语）。 */
export const inject = ['slots', 'sessions', 'locale']

/**
 * 插件体：安装 locale 与卡片/弹窗注册。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const cx = compat(ctx)
  const locale = cx.locale

  // 样式挂载：css-render 对象树，apply 生命周期内挂载/卸载。
  ctx.effect(() => mountDialogStyles(), 'turnrewind dialog styles')
  ctx.effect(() => mountCommandViewStyles(), 'turnrewind command-view styles')
  ctx.effect(() => mountRecoveryStyles(), 'turnrewind recovery styles')

  const t = (key: LocaleKey): string => {
    const active = locale.getLocale().active
    const dict = LOCALES[(active as 'zh' | 'en') in LOCALES ? (active as 'zh' | 'en') : 'zh']
    return dict[key]
  }

  // 恢复面板入口：不可用弹窗在 reason 命中恢复围栏时展示「打开恢复面板」。
  ctx.effect(() => setRecoveryOpener(() => openRecoveryDialog(t)), 'turnrewind recovery opener')

  // ————————————————— 命令卡片 slot 注册 —————————————————
  ctx.effect(() => registerCommandView(ctx), 'turnrewind command view')

  // ————————————————— locale 安装 —————————————————
  ctx.effect(() => {
    const disposer = locale.register(TURNREWIND_LOCALE_NS, 'zh', Object.fromEntries(Object.entries(LOCALES.zh)))
    return disposer
  }, 'turnrewind locale')
  ctx.effect(() => {
    const disposer = locale.register(TURNREWIND_LOCALE_NS, 'en', Object.fromEntries(Object.entries(LOCALES.en)))
    return disposer
  }, 'turnrewind locale en')

  // ————————————————— 卡片 locale 通道 —————————————————
  // 组件经 slot props 拿不到 locale 服务：由 apply 层把取词函数注入组件模块
  // （setSubmitLine/setCardTranslator 都是 latest-owner-wins，撤销函数直接
  // 作为 effect disposer——HMR 时旧实例的撤销不会清掉新实例的通道）。
  ctx.effect(() => setCardTranslator(t), 'turnrewind card translator')

  // ————————————————— ✓/✗ 提交通道 —————————————————
  // 直接 POST 到插件的同源 HTTP 路由（宿主页面本身由同一 Host 服务，无需额外
  // auth wiring）。返回错误字符串让卡片可以显示真实失败原因。
  ctx.effect(() => setSubmitLine(async (line, ownerSessionId) => {
    try {
      if (typeof ownerSessionId !== 'string' || ownerSessionId.length === 0)
        return t('sessionMissing')
      const kind = line.includes('--confirm') ? 'confirm' : 'cancel'
      const planId = line.split(' ').at(-1)!
      const res = await fetch(`${TURNREWIND_HTTP_BASE}/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId, sessionId: ownerSessionId }),
      })
      const payload = await res.json().catch(() => ({}) as Record<string, unknown>)
      if (!res.ok)
        return (payload as { error?: string }).error ?? `HTTP ${res.status}`
      return null
    }
    catch (error) {
      console.error('[turnrewind] failed to submit undo confirmation:', error)
      return String((error as Error)?.message ?? error)
    }
  }), 'turnrewind submit line')

  // ————————————————— 不可用工作区弹窗 runner —————————————————
  // 通过 sessions.list 的投影值读取 Host 注入的 unsupported 提示。
  // 「单会话只报一次」：进入会话（或页面加载）时已存在的提示视为历史留档
  // ——它们已经以会话内消息的形式永久可见，不再重复弹窗（浏览器存储丢
  // 「已读」也不会重弹）；只有页面存活期间新到达的提示才弹一次。
  // 会话服务解析优先 compat 代理（含运行时形状适配），原始 get 兜底，
  // 两路都校验形状——不符即告警而非静默失效。
  const sessions = resolveSessionsService([
    (cx as unknown as { sessions?: unknown }).sessions,
    (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessions'),
  ])
  if (!sessions)
    console.warn('[turnrewind] sessions service unavailable; the unsupported heads-up dialog is disabled')
  const headsUp = createHeadsUpTracker()

  ctx.effect(() => {
    if (!sessions)
      return () => {}
    // 弹窗 runner 的全部资源（订阅/轮询 interval/停轮询 timeout/DOM 卸载）
    // 收敛进一个控制器：dispose 幂等、一次性清理，符合 AGENTS 的
    // Controller 化约定；checkOnce 用 isDisposed 守护 dispose 瞬间的在途回调。
    const controller = createLifecycleController()

    function checkOnce(): void {
      if (controller.isDisposed())
        return
      const state = sessions!.list.getSnapshot() as {
        current?: string
        byId?: Record<string, { projectionValues?: { turnrewind?: unknown } }>
      }
      const summary = state.current !== undefined ? state.byId?.[state.current] : undefined
      const fresh = headsUp.observe(state.current, listNotices(summary?.projectionValues?.turnrewind))
      if (fresh.length === 0)
        return
      console.warn(`[turnrewind] unsupported heads-up visible: ${fresh.map(notice => notice.id).join(', ')}`)
      showDialog(t, fresh)
    }

    controller.add(sessions.list.subscribe(checkOnce))
    // 页面加载时投影帧可能在订阅建立前到达；短暂轮询保证时序不会吞掉提示，
    // 稳定后停掉轮询只留订阅驱动。
    controller.timeout(controller.interval(checkOnce, TURNREWIND_POLL_INTERVAL_MS), TURNREWIND_POLL_STOP_MS)
    controller.add(disposeDialog)
    controller.add(disposeRecoveryDialog)
    return () => controller.dispose()
  }, 'turnrewind dialog runner')
}
