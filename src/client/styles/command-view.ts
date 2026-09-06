/**
 * client/styles/command-view.ts — /undo 卡片样式（css-render 树）。
 *
 * 规则：颜色走主题 token；状态类（成功/失败/运行中）由组件切换 class 而非
 * 直接改 style；diff 行语义类（add/del/hunk/meta/text）集中在此。
 * 挂载语义为 latest-wins（HMR 交错防护，见 styles/index.ts 文件头）。
 */

import { CssRender } from 'dsh-tauri/client'
import { TURNREWIND_CLASS_PREFIX, TURNREWIND_STYLE_ID } from '../constants'

const P = TURNREWIND_CLASS_PREFIX

/**
 * 构建 undo 卡片样式节点。独立导出供测试渲染断言：css-render 不会给数字
 * 自动补 px，这里所有尺寸必须是带单位字符串（曾因裸数字导致 gap /
 * border-radius / font-size 全部失效）。
 */
export function buildCommandViewStyleNodes(cssr: ReturnType<typeof CssRender>) {
  return cssr.c([
    // 折叠态：无边框原生风格行
    // 注意：css-render 不会给数字自动补 px，所有尺寸必须写成带单位字符串，
    // 否则生成非法声明被浏览器丢弃（gap/border-radius/font-size 曾因此全部失效）。
    cssr.c(`.${P}-card`, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '2px 12px 2px 4px',
      margin: '2px 0 2px 4px',
      fontSize: '13px',
    }),
    cssr.c(`.${P}-card-header`, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      textAlign: 'left',
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      padding: '8px 12px',
      color: 'var(--dsw-alias-label-primary, #cccccc)',
      fontSize: '13px',
    }),
    cssr.c(`.${P}-card-caret`, {
      transform: 'rotate(0deg)',
      transition: 'transform .12s',
      display: 'inline-block',
      color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
    }),
    cssr.c(`.${P}-card-caret-open`, {
      transform: 'rotate(90deg)',
    }),
    cssr.c(`.${P}-card-summary`, {
      color: 'var(--dsw-alias-label-secondary, #cccccc)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      flex: 1,
      minWidth: 0,
    }),
    cssr.c(`.${P}-panel-body`, {
      borderTop: '1px solid var(--dsw-alias-border-l2, #30363d)',
      padding: '6px 10px 10px',
    }),
    cssr.c(`.${P}-card-spacer`, {
      flex: 1,
    }),
    cssr.c(`.${P}-card-busy`, {
      cursor: 'wait',
      opacity: 0.75,
    }),
    cssr.c(`.${P}-card-glyph`, {
      color: 'var(--dsw-alias-label-dimmed, #8b8b8b)',
    }),
    cssr.c(`.${P}-card-name`, {
      fontWeight: 500,
      color: 'var(--dsw-alias-label-secondary, #cccccc)',
    }),
    cssr.c(`.${P}-card-dot`, {
      color: 'var(--dsw-alias-label-dimmed, #8b8b8b)',
    }),
    cssr.c(`.${P}-card-hint`, {
      // 高对比：亮色主题黑、暗色主题白（label-primary 随主题切换）。
      color: 'var(--dsw-alias-label-primary, #333333)',
      fontSize: '11.5px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      flex: 1,
    }),
    // 预览提示与 spacer 各占一半 flex，靠 text-align 贴右边。
    cssr.c(`.${P}-card-hint-right`, {
      textAlign: 'right',
    }),
    cssr.c(`.${P}-card-hint-error`, {
      color: 'var(--dsw-alias-state-error-primary, #f85149)',
    }),
    cssr.c(`.${P}-card-hint-ok`, {
      color: 'var(--dsw-alias-state-success-primary, #3fb950)',
    }),
    // 展开态容器：diff 面板（圆角对齐 DSH 原生嵌入卡片档位：.dpte-card 10px）
    cssr.c(`.${P}-panel`, {
      marginTop: '8px',
      border: '1px solid var(--dsw-alias-border-l2, #30363d)',
      borderRadius: '10px',
      overflow: 'hidden',
      background: 'var(--dsw-alias-bg-layer-2, #161b22)',
    }),
    cssr.c(`.${P}-panel-file`, {
      display: 'flex',
      gap: '8px',
      padding: '2px 0',
      fontFamily: 'var(--ds-font-family-code, monospace)',
      fontSize: '12px',
    }),
    // 纯文本正文（--doctor 报告、多行错误说明）：等宽 + 保留缩进与换行。
    cssr.c(`.${P}-panel-textline`, {
      fontFamily: 'var(--ds-font-family-code, monospace)',
      fontSize: '12px',
      lineHeight: '1.5',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      color: 'var(--dsw-alias-label-secondary, #cccccc)',
    }),
    cssr.c(`.${P}-panel-file-change`, {
      color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
      width: '64px',
      flex: 'none',
    }),
    cssr.c(`.${P}-panel-file-path`, {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }),
    cssr.c(`.${P}-panel-diff`, {
      maxHeight: '260px',
      overflowY: 'auto',
      padding: '3px 0',
      borderTop: '1px solid var(--dsw-alias-border-l2, #30363d)',
    }),
    cssr.c(`.${P}-panel-file-header`, {
      padding: '6px 10px 10px',
    }),
    // 数字徽标
    cssr.c(`.${P}-numbadge`, {
      display: 'inline-flex',
      gap: '6px',
      flex: 'none',
      fontFamily: 'var(--ds-font-family-code, monospace)',
      fontSize: '11px',
    }),
    cssr.c(`.${P}-numbadge-add`, {
      color: 'var(--dsw-alias-state-success-primary, #3fb950)',
    }),
    cssr.c(`.${P}-numbadge-del`, {
      color: 'var(--dsw-alias-state-error-primary, #f85149)',
    }),
    // diff 行
    cssr.c(`.${P}-diffline`, {
      display: 'flex',
      fontFamily: 'var(--ds-font-family-code, monospace)',
      fontSize: '12px',
      lineHeight: 1.5,
      whiteSpace: 'pre-wrap',
    }),
    cssr.c(`.${P}-diffline-sign`, {
      width: '14px',
      flex: 'none',
      textAlign: 'center',
    }),
    cssr.c(`.${P}-diffline-text`, {
      flex: 1,
    }),
    cssr.c(`.${P}-diffline-add`, {
      background: 'rgba(63, 185, 80, 0.38)',
      color: 'var(--dsw-alias-state-success-primary, #8ff0a4)',
    }),
    cssr.c(`.${P}-diffline-del`, {
      background: 'rgba(248, 81, 73, 0.26)',
      color: 'var(--dsw-alias-state-error-primary, #ffb3ab)',
    }),
    cssr.c(`.${P}-diffline-hunk`, {
      color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
    }),
    cssr.c(`.${P}-diffline-meta`, {
      color: 'var(--dsw-alias-label-dimmed, #8b8b8b)',
    }),
    cssr.c(`.${P}-diffline-text-line`, {
      color: 'var(--dsw-alias-label-secondary, #cccccc)',
    }),
    // 卡内确认按钮组
    cssr.c(`.${P}-card-actions`, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 12px 10px',
      borderTop: '1px solid var(--dsw-alias-border-l2, #30363d)',
    }),
    cssr.c(`.${P}-card-confirm`, {
      background: 'var(--dsw-alias-button-primary-fill, #2ea043)',
      color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      border: 'none',
      borderRadius: '6px',
      padding: '4px 14px',
      fontSize: '12px',
      cursor: 'pointer',
    }),
    cssr.c(`.${P}-card-cancel`, {
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #cccccc)',
      border: '1px solid var(--dsw-alias-border-l2, #30363d)',
      borderRadius: '6px',
      padding: '4px 14px',
      fontSize: '12px',
      cursor: 'pointer',
    }),
    cssr.c(`.${P}-card-result`, {
      padding: '6px 12px 10px',
      color: 'var(--dsw-alias-label-secondary, #cccccc)',
      fontSize: '12px',
    }),
  ])
}

/** 挂载 undo 卡片样式（latest-wins，见文件头），返回 disposer。 */
export function mountCommandViewStyles(): () => void {
  const styleId = `${TURNREWIND_STYLE_ID}-command-view`
  if (typeof document === 'undefined')
    return () => {}
  document.getElementById(styleId)?.remove()
  const style = buildCommandViewStyleNodes(CssRender())
  style.mount({ id: styleId, head: true })
  return () => style.unmount({ id: styleId })
}
