/**
 * client/components/command-view.ts — /undo 命令卡片 React 组件。
 *
 * 渲染两阶段 undo 的预览卡：徽标（+x -y）、文件清单、点击展开红绿 diff、
 * 确认/取消按钮与 plan 状态轮询。卡片状态以账本为唯一事实来源——刷新页面后
 * 从 persisted plan status 重建，而不是内存态。
 */

import type { CommandViewProps, LocaleKey, ParsedUndoFile, ParsedUndoOutput, Translate } from '../types'
import React, { useEffect, useRef, useState } from 'react'
import { TURNREWIND_CLASS_PREFIX, TURNREWIND_HTTP_BASE, TURNREWIND_POLL_INTERVAL_MS } from '../constants'
import { LOCALES } from '../locales'
import { parseUndoOutput, resolvePlanStatus } from '../utils/parse'
import { openRecoveryPanel } from '../utils/recovery-opener'
import { resolveOwnerSessionId } from '../utils/session'

// ------------------------------------------------------------------
// 颜色：全部引用应用主题 token（带硬编码 fallback），随主题切换实时变化。
// ------------------------------------------------------------------

/** 连续轮询失败上限（404/gone 不计——它们直接 settle plan）。 */
const MAX_POLL_FAILURES = 5

function isFileSeparator(raw: string): boolean {
  return /^--- (?!a\/)(?!b\/)\S/.test(raw)
}

type LineKind = 'del' | 'add' | 'hunk' | 'meta' | 'ctx'

function classifyLine(raw: string): { kind: LineKind, text: string } {
  const line = raw
  if (/^\s*(?:diff --git |index )/.test(line))
    return { kind: 'meta', text: line.trim() }
  if (/^\s*--- a\//.test(line) || /^\s*\+\+\+ b\//.test(line))
    return { kind: 'meta', text: line.trim() }
  if (/^\s*@@/.test(line))
    return { kind: 'hunk', text: line.trim() }
  if (/^\s*-/.test(line))
    return { kind: 'del', text: line.replace(/^\s*-/, '') }
  if (/^\s*\+/.test(line))
    return { kind: 'add', text: line.replace(/^\s*\+/, '') }
  return { kind: 'ctx', text: line.replace(/^\s+/, '') }
}

function diffSign(kind: LineKind): string {
  if (kind === 'del')
    return '-'
  if (kind === 'add')
    return '+'
  return ' '
}

interface DiffLineEntry {
  kind: LineKind
  text: string
}

function DiffLine({ entry }: { entry: DiffLineEntry }): React.ReactElement {
  return React.createElement('div', {
    className: `${TURNREWIND_CLASS_PREFIX}-diffline ${TURNREWIND_CLASS_PREFIX}-diffline-${entry.kind}`,
  }, React.createElement('span', {
    className: `${TURNREWIND_CLASS_PREFIX}-diffline-sign`,
  }, diffSign(entry.kind)), React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-diffline-text` }, entry.text))
}

function NumBadge({ additions, deletions }: { additions: number, deletions: number }): React.ReactElement | null {
  if (additions === 0 && deletions === 0)
    return null
  return React.createElement('span', {
    className: `${TURNREWIND_CLASS_PREFIX}-numbadge`,
  }, React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-numbadge-add` }, `+${additions}`), React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-numbadge-del` }, `-${deletions}`))
}

function DiffBlock({ file }: { file: ParsedUndoFile }): React.ReactElement {
  const rows: React.ReactElement[] = []
  for (const line of file.diff) {
    if (isFileSeparator(line))
      continue
    const trimmed = line.trim()
    if (trimmed.startsWith('diff --git ') || trimmed.startsWith('index ') || trimmed.startsWith('--- a/') || trimmed.startsWith('+++ b/') || trimmed.startsWith('\\'))
      continue
    rows.push(React.createElement(DiffLine, { key: `${file.path}:${rows.length}`, entry: classifyLine(line) }))
  }
  return React.createElement('div', {
    className: `${TURNREWIND_CLASS_PREFIX}-panel`,
  }, React.createElement('div', {
    className: `${TURNREWIND_CLASS_PREFIX}-panel-file-header`,
  }, React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-panel-file-change` }, file.change), React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-panel-file-path` }, file.path), React.createElement(NumBadge, { additions: file.additions, deletions: file.deletions })), React.createElement('div', { className: `${TURNREWIND_CLASS_PREFIX}-panel-diff` }, rows))
}

// ------------------------------------------------------------------
// 提交通道：由 apply() 注入，插件 stop 时置空（effect 生命周期拥有）。
// ------------------------------------------------------------------
type SubmitLine = (line: string, ownerSessionId: string | null) => Promise<string | null>
let submitLine: SubmitLine | null = null

/**
 * 安装提交通道，返回撤销函数。HMR 交错防护（latest-owner-wins）：通道归
 * 最新一次安装所有——旧实例的撤销在通道已被新实例接管后是 no-op，不会把
 * 新通道一起清掉；最新所有者自己撤销时才真正置空。
 */
export function setSubmitLine(next: SubmitLine | null): () => void {
  submitLine = next
  return () => {
    if (submitLine === next)
      submitLine = null
  }
}

/** 测试/诊断观察口：当前生效的提交通道。 */
export function peekSubmitLine(): SubmitLine | null {
  return submitLine
}

// ------------------------------------------------------------------
// locale 通道：与提交通道同一注入模式。组件不直接依赖 locale 服务
// （slot props 不携带它），由 apply() 按当前活跃语言注入取词函数；
// 未注入时回退到 zh 字典——字典即文案的唯一来源，不另存一份硬编码。
// ------------------------------------------------------------------
let translator: Translate | null = null

/** 安装 locale 取词通道（返回撤销函数，latest-owner-wins 语义同 setSubmitLine）。 */
export function setCardTranslator(next: Translate | null): () => void {
  translator = next
  return () => {
    if (translator === next)
      translator = null
  }
}

/** 测试/诊断观察口：当前生效的取词函数。 */
export function peekCardTranslator(): Translate | null {
  return translator
}

function tr(key: LocaleKey): string {
  return translator ? translator(key) : LOCALES.zh[key]
}

// ------------------------------------------------------------------
// 命令卡片组件。props 类型集中在 client/types（P2-10）。
// ------------------------------------------------------------------
export type { CommandViewProps } from '../types'

export function UndoCommandView(props: CommandViewProps): React.ReactElement {
  const node = props.node ?? {}
  const ownerSessionId = resolveOwnerSessionId(props)
  const outcome = node.outcome
  const text = typeof outcome?.text === 'string' ? outcome.text : ''
  const state = outcome == null ? 'running' : outcome.kind === 'error' ? 'error' : 'ok'
  const parsed: ParsedUndoOutput = parseUndoOutput(text)
  const withDiff = parsed.files.filter(file => file.diff.length > 0)
  const totals = parsed.files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 })
  const hasDiff = withDiff.length > 0
  // 无文件清单的输出（--doctor 报告、多行错误说明）走纯文本正文：
  // 否则这类卡片只剩第一行摘要，报告主体被整个吞掉。
  const plainLines = parsed.files.length === 0 && text.includes('\n') ? text.slice(text.indexOf('\n') + 1).split('\n') : []
  // 静态报告行：永不重排/增删；id 预计算，避免 JSX key 直接引用数组下标。
  const plainRows = plainLines.map((line, index) => ({ id: `${index}:${line}`, line }))
  const summary = parsed.summary || (state === 'error' ? tr('cardFailed') : state === 'running' ? tr('cardRunning') : tr('cardDone'))

  // 展开状态按命令持久化：用户折叠后刷新不重新展开。
  // 持久化 key 只用稳定且长度受限的节点标识（node.id / planId）——不回退到
  // 输出摘要（audit P2-8：摘要过长导致 key 膨胀且不稳定）；两者皆缺时不持久化。
  const persistKey = (typeof node.id === 'string' && node.id) || parsed.planId
  const expandKey = persistKey ? `turnrewind.expanded.${persistKey}` : undefined
  const [expanded, setExpanded] = useState(() => {
    if (!expandKey)
      return hasDiff
    try {
      const stored = globalThis.localStorage.getItem(expandKey)
      if (stored === '0' || stored === '1')
        return stored === '1'
    }
    catch {}
    return hasDiff
  })

  function toggleExpanded(): void {
    setExpanded((v) => {
      const next = !v
      if (expandKey) {
        try {
          globalThis.localStorage.setItem(expandKey, next ? '1' : '0')
        }
        catch {}
      }
      return next
    })
  }

  // plan 状态（账本为唯一事实来源；重建后从 persisted state 恢复）。
  const [submitted, setSubmitted] = useState<'confirm' | 'cancel' | null>(null)
  // 提交中状态：点击后立即置位，按钮禁用并显示 spinner，防止重复点击。
  // 注意与 submittingRef 并存：ref 挡同步双击，state 驱动 UI（禁用 + spinner）。
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [resultText, setResultText] = useState<string | null>(null)
  const [planStatus, setPlanStatus] = useState<string | null>(null)

  // 轮询 plan 状态：mount 立即查一次（刷新后从 persisted state 重建卡片），直到 settle。
  useEffect(() => {
    if (state !== 'ok' || !parsed.planId)
      return
    let stop = false
    let timer: ReturnType<typeof setInterval> | null = null
    let failures = 0
    const controller = new AbortController()
    function haltPolling(): void {
      stop = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    async function check(): Promise<void> {
      if (stop)
        return
      try {
        const res = await fetch(`${TURNREWIND_HTTP_BASE}/status?planId=${encodeURIComponent(parsed.planId!)}&sessionId=${encodeURIComponent(ownerSessionId ?? '')}`, { signal: controller.signal })
        const payload = await res.json().catch(() => ({}) as Record<string, unknown>)
        if (stop)
          return
        const httpFailure = !res.ok && res.status !== 404
        const next = resolvePlanStatus({ ok: res.ok, status: res.status }, payload as { status?: string, resultText?: string | null })
        if (next.status !== null && next.status !== 'pending')
          setPlanStatus(next.status)
        else if (next.status === 'pending')
          setPlanStatus('pending')
        if (next.status === 'applied')
          setResultText(next.resultText ?? tr('cardAppliedFallback'))
        if (next.stop) {
          haltPolling()
          return
        }
        // 非 404 的 HTTP 错误（500/503 等）也计入失败预算，避免无限轮询；
        // 只有真实 pending 负载才清零失败计数。
        failures = (!httpFailure && next.status === 'pending') ? 0 : failures + 1
        if (failures >= MAX_POLL_FAILURES)
          haltPolling()
      }
      catch {
        if (stop)
          return
        failures += 1
        if (failures >= MAX_POLL_FAILURES)
          haltPolling()
      }
    }
    void check()
    timer = setInterval(check, TURNREWIND_POLL_INTERVAL_MS)
    return () => {
      controller.abort()
      haltPolling()
    }
  }, [state, parsed.planId, ownerSessionId])

  // 「真不存在」（旧数据被清理/工作区被 purge）与「用户主动取消」折叠为
  // 无边框细行：cancelled 是用户明确放弃，塌缩成一行「已取消」留痕即可；
  // expired 是留档视图，卡片保留文件清单与 diff 供随时回看。
  const collapsed = planStatus === 'gone' || planStatus === 'cancelled' || submitted === 'cancel'
  const showBody = expanded && !collapsed && (hasDiff || parsed.files.length > 0 || plainLines.length > 0)
  const actionable = parsed.planId !== undefined && state === 'ok' && !collapsed && (planStatus === null || planStatus === 'pending')
  // ref 防抖：React 状态更新慢一拍，双击会绕过 state-only 检查发两次请求。
  const submittingRef = useRef(false)

  async function submit(kind: 'confirm' | 'cancel'): Promise<void> {
    if (submittingRef.current || submitting || submitted || !parsed.planId)
      return
    submittingRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    try {
      const line = kind === 'confirm'
        ? `/undo --confirm ${parsed.planId}`
        : `/undo --cancel ${parsed.planId}`
      const failure = submitLine ? await submitLine(line, ownerSessionId) : 'submit channel unavailable'
      if (failure) {
        // 保持可重试：plan 仍 pending。
        setSubmitError(failure)
        submittingRef.current = false
        setSubmitting(false)
        return
      }
      // POST 本身已完成：撤掉 spinner，按钮进入「已提交」态；
      // 最终结果（applied/cancelled）由轮询从账本确认。
      submittingRef.current = false
      setSubmitting(false)
      setSubmitted(kind)
    }
    catch (error) {
      submittingRef.current = false
      setSubmitting(false)
      setSubmitError(String((error as Error)?.message ?? error))
    }
  }

  const confirmLabel = submitting
    ? tr('confirmExecuting')
    : submitted === 'confirm' ? tr('confirmSubmitted') : tr('confirmExecute')
  // submitted === 'cancel' 的卡片已塌缩为细行，完整卡片里取消按钮不存在
  // 「已取消」态：提交中显示取消中，其余显示可点击的取消。
  const cancelLabel = submitting
    ? tr('cancelCancelling')
    : tr('cancelAction')
  // plan 提交即置 applying：提示行不等轮询返回就切到等待态。
  const pendingWait = submitting || submitted === 'confirm' || planStatus === 'applying'
  // P2-11 恢复面板可达性：/undo 错误里命中恢复围栏时，卡片直接给出
  // 「打开恢复面板」入口——弹窗种子逻辑会让历史提示不再重弹，如果只在
  // 弹窗里放入口，被围的用户可能永远到不了面板。
  const underRecovery = (state === 'error' && text.includes('TURNREWIND_RECOVERY_REQUIRED'))
    || Boolean(submitError?.includes('TURNREWIND_RECOVERY_REQUIRED'))
  const hint = submitError
    ? `${tr('confirmFailed')}${submitError}`
    : resultText || (planStatus === 'applied' || pendingWait
      ? tr('cardWaitingResult')
      : planStatus === 'expired'
        ? tr('planExpiredHint')
        : planStatus === 'gone'
          ? tr('planGoneHint')
          : planStatus === 'cancelled' || submitted === 'cancel'
            ? tr('cancelled')
            : underRecovery ? tr('recoveryHint') : tr('previewHint'))
  // 执行结果（成功/失败）靠左展示；「已提交，等待执行结果」与预览提示一样
  // 贴 footer 右缘——等执行结果落地（resultText/applied）再切到左侧。
  const hintLeft = Boolean(resultText || submitError || planStatus === 'applied')
  const hintCls = `${TURNREWIND_CLASS_PREFIX}-card-hint${submitError
    ? ` ${TURNREWIND_CLASS_PREFIX}-card-hint-error`
    : resultText || planStatus === 'applied' ? ` ${TURNREWIND_CLASS_PREFIX}-card-hint-ok` : ''}${hintLeft ? '' : ` ${TURNREWIND_CLASS_PREFIX}-card-hint-right`}`
  const showFooter = actionable || submitting || resultText !== null || submitError !== null || submitted !== null || planStatus === 'applied' || planStatus === 'expired' || planStatus === 'cancelled' || underRecovery

  // 取消/过期折叠为无边框细行。
  if (collapsed) {
    return React.createElement('div', {
      className: `${TURNREWIND_CLASS_PREFIX}-card`,
    }, React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-card-glyph` }, '▸'), React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-card-name` }, node.name || 'undo'), React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-card-dot` }, '·'), React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-card-hint` }, hint))
  }

  const hintSpan = React.createElement('span', { className: hintCls }, hint)
  return React.createElement('div', {
    className: `${TURNREWIND_CLASS_PREFIX}-panel`,
  },
  // 可折叠标题行。
  React.createElement('button', {
    type: 'button',
    onClick: toggleExpanded,
    className: `${TURNREWIND_CLASS_PREFIX}-card-header`,
  }, React.createElement('span', {
    className: `${TURNREWIND_CLASS_PREFIX}-card-caret${expanded ? ` ${TURNREWIND_CLASS_PREFIX}-card-caret-open` : ''}`,
  }, '▸'), React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-card-name` }, node.name || 'undo'), React.createElement(NumBadge, { additions: totals.additions, deletions: totals.deletions }), React.createElement('span', {
    className: `${TURNREWIND_CLASS_PREFIX}-card-summary`,
  }, summary)),
  // 文件清单 / diff 内容；无结构化清单时（--doctor、多行错误）渲染纯文本。
  showBody
    ? React.createElement('div', {
        className: `${TURNREWIND_CLASS_PREFIX}-panel-body`,
      }, hasDiff
        ? withDiff.map(file => React.createElement(DiffBlock, { key: file.path, file }))
        : parsed.files.length > 0
          ? parsed.files.map(file => React.createElement('div', {
              key: file.path,
              className: `${TURNREWIND_CLASS_PREFIX}-panel-file`,
            }, React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-panel-file-change` }, file.change), React.createElement('span', null, file.path)))
          : plainRows.map(row => React.createElement('div', {
              key: row.id,
              className: `${TURNREWIND_CLASS_PREFIX}-panel-textline`,
            }, row.line === '' ? '\u00A0' : row.line)))
    : null,
  // 操作 footer：按钮在左；提交后结果贴左，预览提示靠右。
  // 恢复围栏态（错误输出含 TURNREWIND_RECOVERY_REQUIRED）：footer 只放
  // 「打开恢复面板」入口，指向宿主注入的恢复面板。
  showFooter
    ? React.createElement('div', {
        className: `${TURNREWIND_CLASS_PREFIX}-card-actions`,
      }, underRecovery
        ? React.createElement('button', {
            type: 'button',
            onClick: () => { openRecoveryPanel() },
            className: `${TURNREWIND_CLASS_PREFIX}-card-confirm`,
          }, tr('recoveryOpen'))
        : null, (!underRecovery && (actionable || submitting))
        ? React.createElement('button', {
            type: 'button',
            onClick: () => { void submit('confirm') },
            disabled: submitting || submitted !== null,
            className: `${TURNREWIND_CLASS_PREFIX}-card-confirm${submitting ? ` ${TURNREWIND_CLASS_PREFIX}-card-busy` : ''}`,
          }, confirmLabel)
        : null, (!underRecovery && (actionable || submitting))
        ? React.createElement('button', {
            type: 'button',
            onClick: () => { void submit('cancel') },
            disabled: submitting || submitted !== null,
            className: `${TURNREWIND_CLASS_PREFIX}-card-cancel${submitting ? ` ${TURNREWIND_CLASS_PREFIX}-card-busy` : ''}`,
          }, cancelLabel)
        : null, hintLeft ? hintSpan : null, React.createElement('span', { className: `${TURNREWIND_CLASS_PREFIX}-card-spacer` }), hintLeft ? null : hintSpan)
    : null)
}
