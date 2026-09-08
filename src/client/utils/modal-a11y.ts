/**
 * client/utils/modal-a11y.ts — 模态弹窗的最小可访问性绑定（P2-6）。
 *
 * Escape 关闭 + Tab 焦点陷阱 + 显示时聚焦卡内首个可交互元素。不可用弹窗与
 * 恢复面板两个 DOM 模态共用；document 级 listener 由 release() 移除，
 * 插件 dispose 时调用。
 */

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface ModalA11yBinding {
  /** 挂到 document keydown 上（bindModalA11y 内部已挂，暴露仅为测试/调试）。 */
  onKeydown: (event: KeyboardEvent) => void
  /** 弹窗显示时调用：记住先前焦点并聚焦卡内首个可交互元素。 */
  takeFocus: () => void
  /** 弹窗关闭时调用：把焦点还给打开弹窗前的元素。 */
  restoreFocus: () => void
  /** 永久释放（插件 dispose）：移除 listener，不再移动焦点。 */
  release: () => void
}

export function bindModalA11y(getCard: () => HTMLElement | null, isVisible: () => boolean, hide: () => void): ModalA11yBinding {
  let previous: HTMLElement | null = null

  const onKeydown = (event: KeyboardEvent): void => {
    if (!isVisible())
      return
    if (event.key === 'Escape') {
      event.preventDefault()
      hide()
      return
    }
    if (event.key !== 'Tab')
      return
    const card = getCard()
    if (!card)
      return
    const focusables = [...card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    if (focusables.length === 0)
      return
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !card.contains(active)) {
      // 焦点落在卡外（例如刚点击了 backdrop 里的空白处）：拉回第一个。
      event.preventDefault()
      focusables[0]!.focus()
      return
    }
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    }
    else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }
  document.addEventListener('keydown', onKeydown)

  return {
    onKeydown,
    takeFocus() {
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const card = getCard()
      const target = card?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? card
      target?.focus()
    },
    restoreFocus() {
      previous?.focus()
      previous = null
    },
    release() {
      document.removeEventListener('keydown', onKeydown)
      // 关闭路径应调用 restoreFocus()；release 只负责 teardown，不把焦点
      // 挪到可能已移除的卡片上。
      previous = null
    },
  }
}
