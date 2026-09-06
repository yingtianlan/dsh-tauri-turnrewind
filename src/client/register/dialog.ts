/**
 * client/register/dialog.ts — 不可用工作区的模态弹窗（双语 + 主题 token）。
 *
 * 弹窗去重不在浏览器存储里做（localStorage 会因换端口/清存储而丢「已读」，
 * 导致历史提示反复重弹）：调用方按「单会话一次」种子逻辑只对页面存活期间
 * 新到达的提示弹窗，历史提示以会话内消息形式永久留档、不再打扰。
 *
 * DOM 直挂（非 React 组件）：弹窗只在 apply 生命周期内存在，stop/HMR 时整个
 * backdrop 子树移除（所有 listener 挂在子树节点上，不会泄漏）。
 */

import type { LocaleKey } from '../locales'
import { TURNREWIND_CLASS_PREFIX, TURNREWIND_STYLE_ID } from '../constants'
import { bindModalA11y } from '../utils/modal-a11y'

export interface UnsupportedNotice {
  id: string
  reason?: string
}

interface DialogElements {
  backdrop: HTMLDivElement
  title: HTMLDivElement
  intro: HTMLDivElement
  reasonLabel: HTMLDivElement
  reasonBox: HTMLDivElement
  recoveryButton: HTMLButtonElement
  button: HTMLButtonElement
  card: HTMLDivElement
}

let dialog: DialogElements | undefined
let a11y: ReturnType<typeof bindModalA11y> | undefined
/** 恢复面板入口（apply() 注入）：reason 命中恢复围栏时展示。 */
let recoveryOpener: (() => void) | null = null

// ------------------------------------------------------------------
// 弹窗 DOM：所有颜色走 CSS variable（随主题实时切换），fallback 到硬编码值。
// ------------------------------------------------------------------
function ensureDialog(): DialogElements {
  if (dialog)
    return dialog
  // HMR 交错防护：模块实例各自持有 dialog 变量，旧实例的清理可能晚于新
  // 实例的安装——安装前先移除文档里残留的同款 backdrop，保证任何时刻
  // 至多一个弹窗层（类名前缀插件私有，不会误伤其他插件）。
  for (const stale of document.querySelectorAll(`.${TURNREWIND_CLASS_PREFIX}-dialog-backdrop`))
    stale.remove()
  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'presentation')
  backdrop.className = `${TURNREWIND_CLASS_PREFIX}-dialog-backdrop`
  backdrop.dataset.visible = 'false'

  const card = document.createElement('div')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.className = `${TURNREWIND_CLASS_PREFIX}-dialog-card`

  const title = document.createElement('div')
  title.className = `${TURNREWIND_CLASS_PREFIX}-dialog-title`

  const intro = document.createElement('div')
  intro.className = `${TURNREWIND_CLASS_PREFIX}-dialog-intro`

  const reasonLabel = document.createElement('div')
  reasonLabel.className = `${TURNREWIND_CLASS_PREFIX}-dialog-reason-label`

  const reasonBox = document.createElement('div')
  reasonBox.className = `${TURNREWIND_CLASS_PREFIX}-dialog-reason`

  const actions = document.createElement('div')
  actions.className = `${TURNREWIND_CLASS_PREFIX}-dialog-actions`
  // 恢复面板入口：默认隐藏，showDialog 按 reason 决定是否展示。
  const recoveryButton = document.createElement('button')
  recoveryButton.type = 'button'
  recoveryButton.className = `${TURNREWIND_CLASS_PREFIX}-dialog-recovery`
  recoveryButton.dataset.visible = 'false'
  recoveryButton.addEventListener('click', () => {
    hide()
    recoveryOpener?.()
  })
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `${TURNREWIND_CLASS_PREFIX}-dialog-button`
  actions.append(recoveryButton, button)

  card.append(title, intro, reasonLabel, reasonBox, actions)
  backdrop.appendChild(card)
  document.body.appendChild(backdrop)

  function hide(): void {
    backdrop.dataset.visible = 'false'
  }
  button.addEventListener('click', hide)
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop)
      hide()
  })

  const elements: DialogElements = { backdrop, title, intro, reasonLabel, reasonBox, recoveryButton, button, card }
  a11y = bindModalA11y(
    () => dialog?.card ?? null,
    () => dialog?.backdrop.dataset.visible === 'true',
    () => {
      backdrop.dataset.visible = 'false'
    },
  )
  dialog = elements
  return dialog
}

/** 插件 stop/HMR 时整个 backdrop 子树移除——listener 全部随之释放。 */
export function disposeDialog(): void {
  a11y?.release()
  a11y = undefined
  if (!dialog)
    return
  dialog.backdrop.remove()
  dialog = undefined
}

/** 注入恢复面板入口（apply() 装配层调用）：latest-owner-wins，返回撤销函数。 */
export function setRecoveryOpener(next: (() => void) | null): () => void {
  recoveryOpener = next
  return () => {
    if (recoveryOpener === next)
      recoveryOpener = null
  }
}

/** 用当前活跃语言填充并显示弹窗；reason 命中恢复围栏时附「恢复面板」入口。 */
export function showDialog(t: (key: LocaleKey) => string, notices: UnsupportedNotice[]): void {
  const el = ensureDialog()
  el.title.textContent = t('dialogTitle')
  el.intro.textContent = t('dialogIntro')
  el.reasonLabel.textContent = t('dialogReason')
  el.reasonBox.textContent = notices.map(notice => notice.reason || notice.id).join('\n')
  el.button.textContent = t('dialogConfirm')
  const underRecovery = notices.some(notice => notice.reason?.includes('TURNREWIND_RECOVERY_REQUIRED'))
  el.recoveryButton.dataset.visible = underRecovery ? 'true' : 'false'
  if (underRecovery)
    el.recoveryButton.textContent = t('recoveryOpen')
  el.backdrop.dataset.visible = 'true'
  a11y?.takeFocus()
}

/**
 * 从会话投影中提取 unsupported 提示（不去重）。去重由调用方的
 * 「单会话一次」种子逻辑承担：进入会话时已存在的提示视为历史留档
 * （会话内消息永久可见），只有页面存活期间新到达的提示才弹窗。
 */
export function listNotices(value: unknown): UnsupportedNotice[] {
  return (Array.isArray((value as { notices?: unknown[] })?.notices)
    ? (value as { notices: unknown[] }).notices
    : []).filter((notice): notice is UnsupportedNotice =>
    notice != null && typeof (notice as UnsupportedNotice).id === 'string')
}

/** style id 导出（供测试断言/未来的 css-render 迁移使用）。 */
export { TURNREWIND_STYLE_ID }
