/**
 * client/utils/recovery-opener.ts — 恢复面板入口的单例通道。
 *
 * dialog（不可用弹窗）与 command-view（/undo 错误卡片）都需要打开恢复
 * 面板；面板实例在 register/recovery.ts，入口经此模块中转，避免组件与
 * register 模块互相依赖。latest-owner-wins：apply() 装配层 set，stop/HMR
 * 时 disposer 置空。
 */

let opener: (() => void) | null = null

export function setRecoveryOpener(next: (() => void) | null): () => void {
  opener = next
  return () => {
    if (opener === next)
      opener = null
  }
}

/** 打开恢复面板；入口未装配（opener 为空）时返回 false 供调用方降级提示。 */
export function openRecoveryPanel(): boolean {
  if (!opener)
    return false
  opener()
  return true
}
