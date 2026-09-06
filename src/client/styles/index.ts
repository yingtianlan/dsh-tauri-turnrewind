/**
 * client/styles/index.ts — css-render 样式树（dialog + command card）。
 *
 * 按 AGENTS.plugins.md 约定：样式对象树由 css-render 生成，style id / class
 * 使用插件前缀；挂载/卸载由 apply() 的 effect 管理。
 *
 * HMR 交错防护（latest-wins）：同 id 样式已存在时先移除再挂载，新安装取得
 * 所有权；旧实例的 unmount 只认它自己 capture 的元素，落空为 no-op。类名
 * 前缀插件私有——AGENTS「不得夺取所有权」防的是跨插件/跨生命周期抢占，
 * 同插件重入（HMR）恰恰需要最新实例接管，否则旧 disposer 会拆掉新实例
 * 依赖的样式。
 *
 * 命名空间：dialog 节点统一使用 `-dialog-*` 前缀，与 command-view 树的
 * `-card-*` / `-panel-*` / `-diffline-*` 类零重叠——两棵树同时挂载时
 * CSS 规则互不污染。
 */

import { CssRender } from 'dsh-tauri/client'
import { TURNREWIND_CLASS_PREFIX, TURNREWIND_STYLE_ID } from '../constants'

/** 挂载不可用弹窗样式，返回 disposer。 */
export function buildDialogStyleNodes(cssr: ReturnType<typeof CssRender>) {
  const p = TURNREWIND_CLASS_PREFIX
  return cssr.c([
    cssr.c(`.${p}-dialog-backdrop`, {
      display: 'none',
      position: 'fixed',
      inset: 0,
      zIndex: 2147483000,
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))',
    }),
    cssr.c(`.${p}-dialog-backdrop[data-visible='true']`, {
      display: 'flex',
    }),
    cssr.c(`.${p}-dialog-card`, {
      maxWidth: '440px',
      width: 'calc(100vw - 48px)',
      boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #111111)',
      border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
      borderRadius: '12px',
      padding: '20px 22px',
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: 1.6,
      boxShadow: '0 20px 50px rgba(0, 0, 0, 0.25)',
    }),
    cssr.c(`.${p}-dialog-title`, {
      fontSize: '15px',
      fontWeight: '600',
      marginBottom: '10px',
      color: 'var(--dsw-alias-state-error-primary, #d03050)',
    }),
    cssr.c(`.${p}-dialog-intro`, {
      color: 'var(--dsw-alias-label-secondary, #333333)',
    }),
    cssr.c(`.${p}-dialog-reason-label`, {
      marginTop: '12px',
      color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
      fontSize: '12px',
    }),
    cssr.c(`.${p}-dialog-reason`, {
      marginTop: '6px',
      padding: '8px 10px',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
      border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
      wordBreak: 'break-all',
      whiteSpace: 'pre-wrap',
      maxHeight: '160px',
      overflowY: 'auto',
    }),
    cssr.c(`.${p}-dialog-actions`, {
      marginTop: '16px',
      textAlign: 'right',
    }),
    cssr.c(`.${p}-dialog-button`, {
      background: 'var(--dsw-alias-button-primary-fill, #4f46e5)',
      color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      border: 'none',
      borderRadius: '8px',
      padding: '6px 18px',
      fontSize: '13px',
      cursor: 'pointer',
    }),
    cssr.c(`.${p}-dialog-button:hover`, {
      background: 'var(--dsw-alias-button-primary-hover, #4338ca)',
    }),
    // 恢复面板入口（默认 display:none，data-visible 控制展示）。
    cssr.c(`.${p}-dialog-recovery`, {
      display: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, #111111)',
      border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
      borderRadius: '8px',
      padding: '6px 14px',
      fontSize: '13px',
      cursor: 'pointer',
    }),
    cssr.c(`.${p}-dialog-recovery[data-visible='true']`, {
      display: 'inline-block',
    }),
  ])
}

/** 挂载不可用弹窗样式（latest-wins，见文件头），返回 disposer。 */
export function mountDialogStyles(): () => void {
  const styleId = `${TURNREWIND_STYLE_ID}-dialog`
  if (typeof document === 'undefined')
    return () => {}
  document.getElementById(styleId)?.remove()
  const style = buildDialogStyleNodes(CssRender())
  style.mount({ id: styleId, head: true })
  return () => style.unmount({ id: styleId })
}

/** 构建恢复面板样式节点（独立导出供测试断言）。 */
export function buildRecoveryStyleNodes(cssr: ReturnType<typeof CssRender>) {
  const p = TURNREWIND_CLASS_PREFIX
  return cssr.c([
    cssr.c(`.${p}-recovery-backdrop`, {
      display: 'none',
      position: 'fixed',
      inset: 0,
      zIndex: 2147483000,
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))',
    }),
    cssr.c(`.${p}-recovery-backdrop[data-visible='true']`, {
      display: 'flex',
    }),
    cssr.c(`.${p}-recovery-card`, {
      maxWidth: '620px',
      width: 'calc(100vw - 48px)',
      boxSizing: 'border-box',
      maxHeight: '80vh',
      overflowY: 'auto',
      background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #111111)',
      border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
      borderRadius: '12px',
      padding: '20px 22px',
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: 1.6,
      boxShadow: '0 20px 50px rgba(0, 0, 0, 0.25)',
    }),
    cssr.c(`.${p}-recovery-title`, {
      fontSize: '15px',
      fontWeight: '600',
      marginBottom: '10px',
      color: 'var(--dsw-alias-state-error-primary, #d03050)',
    }),
    cssr.c(`.${p}-recovery-intro`, {
      color: 'var(--dsw-alias-label-secondary, #333333)',
      marginBottom: '12px',
    }),
    cssr.c(`.${p}-recovery-empty`, {
      color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
    }),
    cssr.c(`.${p}-recovery-workspace`, {
      border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
      borderRadius: '8px',
      padding: '10px 12px',
      marginBottom: '10px',
    }),
    cssr.c(`.${p}-recovery-path`, {
      fontFamily: 'monospace',
      fontSize: '12px',
      wordBreak: 'break-all',
      marginBottom: '6px',
    }),
    cssr.c(`.${p}-recovery-op`, {
      color: 'var(--dsw-alias-label-secondary, #333333)',
      fontSize: '12px',
      wordBreak: 'break-all',
      marginBottom: '4px',
    }),
    cssr.c(`.${p}-recovery-error`, {
      display: 'none',
      marginTop: '10px',
      padding: '8px 10px',
      borderRadius: '8px',
      background: 'var(--dsw-alias-state-error-bg, #fdecef)',
      color: 'var(--dsw-alias-state-error-primary, #d03050)',
      wordBreak: 'break-all',
      whiteSpace: 'pre-wrap',
    }),
    cssr.c(`.${p}-recovery-error[data-visible='true']`, {
      display: 'block',
    }),
    cssr.c(`.${p}-recovery-actions`, {
      marginTop: '10px',
      display: 'flex',
      gap: '8px',
      justifyContent: 'flex-end',
    }),
    cssr.c(`.${p}-recovery-btn`, {
      background: 'var(--dsw-alias-button-primary-fill, #4f46e5)',
      color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      border: 'none',
      borderRadius: '8px',
      padding: '6px 14px',
      fontSize: '13px',
      cursor: 'pointer',
    }),
    cssr.c(`.${p}-recovery-btn:disabled`, {
      opacity: 0.6,
      cursor: 'default',
    }),
    cssr.c(`.${p}-recovery-btn-danger`, {
      background: 'var(--dsw-alias-state-error-primary, #d03050)',
    }),
  ])
}

/** 挂载恢复面板样式（latest-wins，见文件头），返回 disposer。 */
export function mountRecoveryStyles(): () => void {
  const styleId = `${TURNREWIND_STYLE_ID}-recovery`
  if (typeof document === 'undefined')
    return () => {}
  document.getElementById(styleId)?.remove()
  const style = buildRecoveryStyleNodes(CssRender())
  style.mount({ id: styleId, head: true })
  return () => style.unmount({ id: styleId })
}

export { mountCommandViewStyles } from './command-view'
