// dsh-tauri-turnrewind — client bundle (browser).
//
// One module, three jobs (the boot manifest imports the plugin under its
// package name, so everything lives in this single factory):
// 1. Renders the `/undo` command card in the `conversation.chat.commandview`
//    slot: +x -y badge, changed-file list, click-to-expand red/green diffs.
// 2. Raises the in-app "undo unavailable" dialog when the current session
//    carries the unsupported-workspace heads-up injected by the host.
//
// Hand-written against the DSH client module contract:
//   window.__ModuleLoader__.load({ id, factory }) where factory receives a
//   CommonJS-style `require` and must export `apply` (cordis plugin) + `inject`
//   (services the apply() context needs). The module system strips a trailing
//   `/client` from ids, so this id normalizes to the package name.
globalThis.__ModuleLoader__.load({
  id: 'dsh-tauri-turnrewind/client',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const jsx = jsxRuntime.jsx
    const jsxs = jsxRuntime.jsxs

    const inject = ['slots', 'sessions', 'locale']
    // The ✓/✗ buttons post to the plugin's same-origin HTTP routes (the harness
    // page itself is served by the same host, so no auth wiring is needed);
    // assigned from apply() once the ctx is available.
    let submitLine = null

    // ------------------------------------------------------------------
    // /undo output parsing: the command prints a structured plain-text plan
    // (summary line, indented file list, per-file unified diff sections)
    // plus a trailing machine-readable `plan <id>` confirmation row.
    // ------------------------------------------------------------------
    function isFileSeparator(raw) {
      return /^--- (?!a\/)(?!b\/)\S/.test(raw)
    }

    function parseUndoOutput(raw) {
      const lines = (raw ?? '').split('\n')
      const result = { summary: lines[0] ?? '', files: [], dividers: [], planId: undefined }
      let current = null
      let inDiffs = false
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]
        const planRow = /^plan ([0-9a-f-]+)$/.exec(line)
        if (planRow) {
          result.planId = planRow[1]
          continue
        }
        if (/^Send \/undo --(?:confirm|cancel)/.test(line))
          continue
        if (/^(?:Undo will apply|Conflicts \()/.test(line)) {
          inDiffs = true
          result.dividers.push(line)
          continue
        }
        const listed = /^ {2,}(modified|created|deleted) (\S+)$/.exec(line)
        if (listed && !inDiffs) {
          result.files.push({ path: listed[2], change: listed[1], additions: 0, deletions: 0, diff: [] })
          continue
        }
        const separator = /^--- (?!a\/)(?!b\/)(.+)$/.exec(line)
        if (separator && inDiffs) {
          const path = separator[1].trim()
          current = result.files.find(file => file.path === path)
          if (!current) {
            current = { path, change: 'conflict', additions: 0, deletions: 0, diff: [] }
            result.files.push(current)
          }
          current.diff = []
          continue
        }
        if (current && line.trim() !== '' && inDiffs) {
          const trimmed = line.trim()
          if (/^\+/.test(trimmed) && !/^\+\+\+/.test(trimmed))
            current.additions += 1
          else if (trimmed.startsWith('-') && !trimmed.startsWith('---'))
            current.deletions += 1
          current.diff.push(line)
        }
      }
      return result
    }

    // ------------------------------------------------------------------
    // /undo command card: rendering.
    // ------------------------------------------------------------------
    const DIFF_COLORS = {
      delBg: 'rgba(248, 81, 73, 0.26)',
      addBg: 'rgba(63, 185, 80, 0.38)',
      del: 'var(--dsw-alias-state-error-primary, #f85149)',
      add: 'var(--dsw-alias-state-success-primary, #3fb950)',
      delText: 'var(--dsw-alias-state-error-primary, #ffb3ab)',
      addText: 'var(--dsw-alias-state-success-primary, #8ff0a4)',
      hunk: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
      meta: 'var(--dsw-alias-label-dimmed, #8b8b8b)',
      text: 'var(--dsw-alias-label-secondary, #cccccc)',
      bg: 'var(--dsw-alias-bg-layer-2, #161b22)',
      border: 'var(--dsw-alias-border-l2, #30363d)',
    }

    function diffLineStyle(kind) {
      switch (kind) {
        case 'del': return { background: DIFF_COLORS.delBg, color: DIFF_COLORS.delText }
        case 'add': return { background: DIFF_COLORS.addBg, color: DIFF_COLORS.addText }
        case 'hunk': return { color: DIFF_COLORS.hunk }
        case 'meta': return { color: DIFF_COLORS.meta }
        default: return { color: DIFF_COLORS.text }
      }
    }

    function diffSign(kind) {
      if (kind === 'del')
        return '-'
      if (kind === 'add')
        return '+'
      return ' '
    }

    function DiffLine(props) {
      const entry = props.entry
      return jsxs('div', {
        style: Object.assign(
          { display: 'flex', fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: '12px', lineHeight: '19px', paddingLeft: 8, paddingRight: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
          diffLineStyle(entry.kind),
        ),
        children: [
          jsx('span', {
            style: { width: 14, flex: 'none', color: entry.kind === 'del' ? DIFF_COLORS.del : entry.kind === 'add' ? DIFF_COLORS.add : 'transparent', userSelect: 'none' },
            children: diffSign(entry.kind),
          }),
          jsx('span', { style: { flex: 1 }, children: entry.text }),
        ],
      })
    }

    function NumBadge(props) {
      const { additions, deletions } = props
      if (additions === 0 && deletions === 0)
        return null
      return jsxs('span', {
        style: { display: 'inline-flex', gap: 6, flex: 'none', fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 11 },
        children: [
          jsx('span', { style: { color: 'var(--dsw-alias-state-success-primary, #3fb950)' }, children: `+${additions}` }),
          jsx('span', { style: { color: 'var(--dsw-alias-state-error-primary, #f85149)' }, children: `-${deletions}` }),
        ],
      })
    }

    function classifyLine(raw) {
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

    function DiffBlock(props) {
      const file = props.file
      const rows = []
      for (const line of file.diff) {
        if (isFileSeparator(line))
          continue
        // VSCode-style clean diff: drop git plumbing noise (diff --git / index /
        // --- a/ / +++ b/ headers and the "\ No newline" markers) and keep only
        // hunk headers plus +/- content lines.
        const trimmed = line.trim()
        if (trimmed.startsWith('diff --git ') || trimmed.startsWith('index ') || trimmed.startsWith('--- a/') || trimmed.startsWith('+++ b/') || trimmed.startsWith('\\'))
          continue
        rows.push(jsx(DiffLine, { entry: classifyLine(line) }, `${file.path}:${rows.length}`))
      }
      return jsxs('div', {
        style: { marginTop: 8, border: `1px solid ${DIFF_COLORS.border}`, borderRadius: 8, overflow: 'hidden' },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, #cccccc)', borderBottom: `1px solid ${DIFF_COLORS.border}`, background: 'var(--dsw-alias-bg-layer-1, transparent)' },
            children: [
              jsx('span', { style: { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)' }, children: file.change }),
              jsx('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: file.path }),
              jsx(NumBadge, { additions: file.additions, deletions: file.deletions }),
            ],
          }),
          jsx('div', { style: { maxHeight: 260, overflowY: 'auto', padding: '3px 0' }, children: rows }),
        ],
      })
    }

    function UndoCommandView(props) {
      const node = props.node || {}
      const outcome = node.outcome
      const text = outcome && typeof outcome.text === 'string' ? outcome.text : ''
      const state = outcome == null ? 'running' : outcome.kind === 'error' ? 'error' : 'ok'
      const parsed = parseUndoOutput(text)
      const withDiff = parsed.files.filter(file => (file.diff?.length ?? 0) > 0)
      const totals = parsed.files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 })
      const hasDiff = withDiff.length > 0
      const summary = parsed.summary || (state === 'error' ? '失败' : state === 'running' ? '运行中' : '完成')
      // Remember the user's collapse choice per command: a refresh must not
      // re-expand a card the user deliberately folded.
      const expandKey = `turnrewind.expanded.${node.id ?? parsed.planId ?? parsed.summary}`
      const [expanded, setExpanded] = React.useState(hasDiff)
      React.useEffect(() => {
        try {
          const stored = globalThis.localStorage.getItem(expandKey)
          if (stored === '0' || stored === '1')
            setExpanded(stored === '1')
        }
        catch {}
      }, [expandKey])
      function toggleExpanded() {
        setExpanded((v) => {
          const next = !v
          try {
            globalThis.localStorage.setItem(expandKey, next ? '1' : '0')
          }
          catch {}
          return next
        })
      }
      const [submitted, setSubmitted] = React.useState(null)
      const [submitError, setSubmitError] = React.useState(null)
      const [resultText, setResultText] = React.useState(null)
      // The plan's persisted status is the source of truth: it survives page
      // reloads, so the card state (buttons vs applied vs cancelled) rebuilds
      // from it instead of from in-memory React state.
      const [planStatus, setPlanStatus] = React.useState(null)

      // Poll the plan status: immediately on mount (a reload must rebuild the
      // card from the persisted state) and until the plan settles.
      React.useEffect(() => {
        if (state !== 'ok' || !parsed.planId)
          return
        let stop = false
        let timer = null
        async function check() {
          if (stop)
            return
          try {
            const res = await fetch(`/api/turnrewind/status?planId=${encodeURIComponent(parsed.planId)}`)
            const payload = await res.json().catch(() => ({}))
            if (stop || res.ok === false)
              return
            setPlanStatus(payload.status)
            if (payload.status === 'applied') {
              setResultText(payload.resultText ?? '已执行')
              clearInterval(timer)
            }
            else if (payload.status === 'cancelled') {
              clearInterval(timer)
            }
          }
          catch {}
        }
        void check()
        timer = setInterval(check, 1500)
        return () => {
          stop = true
          if (timer !== null)
            clearInterval(timer)
        }
      }, [state, parsed.planId])

      const titleColor = state === 'error' ? 'var(--dsw-alias-state-error-primary, #f85149)' : 'var(--dsw-alias-label-primary, #cccccc)'
      // Cancelled/expired plans collapse to a minimal red card: no file list,
      // no diffs, no buttons — nothing that a refresh could resurrect.
      const collapsed = planStatus === 'cancelled' || planStatus === 'gone'
      const showBody = expanded && !collapsed && (hasDiff || parsed.files.length > 0)
      const actionable = parsed.planId !== undefined && state === 'ok' && !collapsed && (planStatus === null || planStatus === 'pending')
      // A synchronous ref guard closes the re-render gap: React state updates
      // land a tick later, so fast double-clicks would both pass a state-only
      // check and fire two confirm requests.
      const submittingRef = React.useRef(false)

      async function submit(kind) {
        if (submittingRef.current || submitted || !parsed.planId)
          return
        submittingRef.current = true
        try {
          const line = kind === 'confirm'
            ? `/undo --confirm ${parsed.planId}`
            : `/undo --cancel ${parsed.planId}`
          const failure = submitLine ? await submitLine(line) : 'submit channel unavailable'
          if (failure) {
            setSubmitError(failure)
            submittingRef.current = false
          }
          else {
            setSubmitted(kind)
          }
          if (kind === 'cancel')
            setPlanStatus('cancelled')
        }
        catch (error) {
          submittingRef.current = false
          setSubmitError(String(error?.message ?? error))
        }
      }

      const confirmLabel = submitted === 'confirm' ? '已提交执行确认' : '✓ 执行'
      const cancelLabel = submitted === 'cancel' ? '已取消' : '✕ 取消'
      const hint = submitError
        ? `执行确认失败：${submitError}`
        : resultText || (planStatus === 'applied' || submitted === 'confirm'
          ? '已提交，等待执行结果…'
          : planStatus === 'cancelled' || submitted === 'cancel' ? '已取消' : planStatus === 'gone' ? '该计划已过期，重新执行 /undo 可生成新预览' : '执行将恢复下方文件到本轮改动前')
      const hintColor = submitError
        ? 'var(--dsw-alias-state-error-primary, #f85149)'
        : resultText || planStatus === 'applied'
          ? 'var(--dsw-alias-state-success-primary, #3fb950)'
          : 'var(--dsw-alias-label-secondary, #333333)'
      // Buttons live only in the actionable footer; the outcome/error hint line
      // must survive after the plan settles, or the success note disappears.
      const showFooter = actionable || resultText !== null || submitError !== null || submitted !== null || planStatus === 'applied'

      // Cancelled/expired plans collapse to a frameless slim line, matching
      // the native tool-row look: no card frame, no body, no buttons.
      if (collapsed) {
        return jsxs('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 12px 2px 4px', margin: '2px 0 2px 4px', fontSize: 13 },
          children: [
            jsx('span', { style: { color: 'var(--dsw-alias-label-dimmed, #8b8b8b)' }, children: '▸' }),
            jsx('span', { style: { color: 'var(--dsw-alias-label-secondary, #cccccc)' }, children: node.name || 'undo' }),
            jsx('span', { style: { color: 'var(--dsw-alias-label-dimmed, #8b8b8b)' }, children: '·' }),
            jsx('span', { style: { color: 'var(--dsw-alias-state-error-primary, #f85149)' }, children: hint }),
          ],
        })
      }

      return jsxs('div', {
        style: { border: `1px solid ${DIFF_COLORS.border}`, background: 'var(--dsw-alias-bg-layer-1, transparent)', borderRadius: 12, margin: '4px 0 4px 4px', overflow: 'hidden', maxWidth: '100%' },
        children: [
          jsxs('button', {
            type: 'button',
            onClick() { toggleExpanded() },
            style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: '8px 12px', color: titleColor, fontSize: 13 },
            children: [
              jsx('span', { style: { transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .12s', display: 'inline-block', color: 'var(--dsw-alias-label-tertiary, #8b8b8b)' }, children: '▸' }),
              jsx('span', { style: { fontWeight: 500 }, children: node.name || 'undo' }),
              jsx(NumBadge, { additions: totals.additions, deletions: totals.deletions }),
              jsx('span', { style: { color: 'var(--dsw-alias-label-secondary, #cccccc)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }, children: summary }),
            ],
          }),
          showBody
            ? jsx('div', { style: { borderTop: `1px solid ${DIFF_COLORS.border}`, padding: hasDiff ? '6px 10px 10px' : '6px 12px 10px' }, children:
              hasDiff
                ? withDiff.map(file => jsx(DiffBlock, { file }, file.path))
                : parsed.files.map(file => jsxs('div', { style: { display: 'flex', gap: 8, padding: '2px 0', fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12 }, children: [
                    jsx('span', { style: { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', width: 64, flex: 'none' }, children: file.change }),
                    jsx('span', { children: file.path }),
                  ] }, file.path)) })
            : null,
          showFooter
            ? jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: 10, borderTop: `1px solid ${DIFF_COLORS.border}`, padding: '8px 12px' },
                children: [
                  actionable
                    ? jsxs('button', {
                        type: 'button',
                        onClick() { submit('confirm') },
                        disabled: submitted !== null,
                        style: { background: 'var(--dsw-alias-button-primary-fill, #4f46e5)', color: 'var(--dsw-alias-label-primary-foreground, #ffffff)', border: 'none', borderRadius: 8, padding: '5px 16px', fontSize: 12.5 },
                        children: confirmLabel,
                      })
                    : null,
                  actionable
                    ? jsx('button', {
                        type: 'button',
                        onClick() { submit('cancel') },
                        disabled: submitted !== null,
                        style: { background: 'transparent', color: submitted === 'cancel' ? 'var(--dsw-alias-label-tertiary, #8b8b8b)' : 'var(--dsw-alias-state-error-primary, #f85149)', border: '1px solid var(--dsw-alias-border-l2, #30363d)', borderRadius: 8, padding: '5px 16px', fontSize: 12.5 },
                        children: cancelLabel,
                      })
                    : null,
                  jsx('span', { style: { flex: 1 } }),
                  jsx('span', { style: { color: hintColor, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: hint }),
                ],
              })
            : null,
        ],
      })
    }

    // ------------------------------------------------------------------
    // Unsupported-workspace dialog: storage, DOM, and runner.
    // ------------------------------------------------------------------
    const NS = 'dsh-tauri-turnrewind'
    const SEEN_KEY = 'turnrewind.seenUnsupportedNotices'
    const MAX_SEEN = 100

    const dictionaries = {
      zh: {
        title: '撤销功能在此工作区不可用',
        intro: '当前会话的工作区不支持文件撤销。对话照常运行，但本工作区内的文件改动无法用 /undo 撤销。',
        reason: '原因',
        ok: '知道了',
      },
      en: {
        title: 'Undo is unavailable in this workspace',
        intro: 'File undo is disabled for this session\'s workspace. Turns still run normally, but changes in this workspace cannot be reverted with /undo.',
        reason: 'Reason',
        ok: 'Got it',
      },
    }

    function readSeen() {
      try {
        const raw = globalThis.localStorage.getItem(SEEN_KEY)
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) ? list : []
      }
      catch {
        return []
      }
    }

    function markSeen(id) {
      try {
        const seen = readSeen().filter(entry => entry !== id)
        seen.push(id)
        globalThis.localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-MAX_SEEN)))
      }
      catch {
        // Storage may be unavailable; the dialog just re-shows next reload.
      }
    }

    let dialog

    function ensureDialog() {
      if (dialog)
        return dialog
      // Colors are app theme tokens (with hardcoded fallbacks), so the dialog
      // follows the in-app light/dark theme live — inline `var()` re-resolves
      // when the theme switches, no rebuild needed.
      const backdrop = document.createElement('div')
      backdrop.setAttribute('role', 'presentation')
      Object.assign(backdrop.style, {
        display: 'none',
        position: 'fixed',
        inset: '0',
        zIndex: '2147483000',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))',
      })

      const card = document.createElement('div')
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-modal', 'true')
      Object.assign(card.style, {
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
        lineHeight: '1.6',
        boxShadow: '0 20px 50px rgba(0, 0, 0, 0.25)',
      })

      const title = document.createElement('div')
      Object.assign(title.style, {
        fontSize: '15px',
        fontWeight: '600',
        marginBottom: '10px',
        color: 'var(--dsw-alias-state-error-primary, #d03050)',
      })

      const intro = document.createElement('div')
      Object.assign(intro.style, { color: 'var(--dsw-alias-label-secondary, #333333)' })

      const reasonLabel = document.createElement('div')
      Object.assign(reasonLabel.style, { marginTop: '12px', color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', fontSize: '12px' })

      const reasonBox = document.createElement('div')
      Object.assign(reasonBox.style, {
        marginTop: '6px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
        border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
        wordBreak: 'break-all',
        whiteSpace: 'pre-wrap',
        maxHeight: '160px',
        overflowY: 'auto',
      })

      const actions = document.createElement('div')
      Object.assign(actions.style, { marginTop: '16px', textAlign: 'right' })
      const button = document.createElement('button')
      button.type = 'button'
      Object.assign(button.style, {
        background: 'var(--dsw-alias-button-primary-fill, #4f46e5)',
        color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
        border: 'none',
        borderRadius: '8px',
        padding: '6px 18px',
        fontSize: '13px',
        cursor: 'pointer',
      })
      button.addEventListener('mouseover', () => {
        button.style.background = 'var(--dsw-alias-button-primary-hover, #4338ca)'
      })
      button.addEventListener('mouseout', () => {
        button.style.background = 'var(--dsw-alias-button-primary-fill, #4f46e5)'
      })
      actions.appendChild(button)

      card.append(title, intro, reasonLabel, reasonBox, actions)
      backdrop.appendChild(card)
      document.body.appendChild(backdrop)

      function hide() {
        backdrop.style.display = 'none'
      }
      button.addEventListener('click', hide)
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop)
          hide()
      })

      dialog = { backdrop, title, intro, reasonLabel, reasonBox, button }
      return dialog
    }

    function showDialog(t, notices) {
      const el = ensureDialog()
      el.title.textContent = t('title')
      el.intro.textContent = t('intro')
      el.reasonLabel.textContent = t('reason')
      el.reasonBox.textContent = notices.map(notice => notice.reason || notice.id).join('\n')
      el.button.textContent = t('ok')
      el.backdrop.style.display = 'flex'
    }

    // ------------------------------------------------------------------
    // Plugin apply: both features share the one cordis plugin this bundle
    // materializes into (the boot manifest imports the package name).
    // ------------------------------------------------------------------
    function apply(ctx) {
      console.warn('[turnrewind] client apply: command card + dialog runner starting')

      ctx.effect(() => {
        ctx.slots.inject('conversation.chat.commandview', () => {
          return ctx.slots.register({
            name: 'conversation.chat.commandview',
            key: 'undo',
          }, UndoCommandView)
        })
      }, 'turnrewind command view')

      // Unsupported-workspace heads-up runner.
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'turnrewind locale')
      const t = ctx.locale.bind(NS)
      // Read through the service store, not the ctx.sessions property proxy:
      // the host session service merges a different member under the same name.
      const sessions = ctx.get('sessions')
      // The ✓/✗ buttons post to the plugin's same-origin routes — the most
      // direct client→host channel (no gateway RPC, no auth wiring). Returns
      // an error string so the card can surface real failures instead of
      // silently swallowing an async rejection.
      submitLine = async (line) => {
        try {
          const sessionId = sessions.list.getSnapshot().current
          if (sessionId === undefined)
            return 'no active session in the client session list'
          const kind = line.includes('--confirm') ? 'confirm' : 'cancel'
          const planId = line.split(' ').at(-1)
          const res = await fetch(`/api/turnrewind/${kind}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ planId, sessionId }),
          })
          const payload = await res.json().catch(() => ({}))
          if (!res.ok)
            return payload.error ?? `HTTP ${res.status}`
          return null
        }
        catch (error) {
          console.error('[turnrewind] failed to submit undo confirmation:', error)
          return String(error?.message ?? error)
        }
      }

      function checkOnce() {
        const state = sessions.list.getSnapshot()
        const summary = state.current !== undefined ? state.byId[state.current] : undefined
        const value = summary?.projectionValues?.turnrewind
        const notices = Array.isArray(value?.notices) ? value.notices : []
        const fresh = notices.filter(notice => notice && typeof notice.id === 'string' && !readSeen().includes(notice.id))
        if (fresh.length === 0)
          return
        console.warn(`[turnrewind] unsupported heads-up visible: ${fresh.map(notice => notice.id).join(', ')}`)
        for (const notice of fresh) markSeen(notice.id)
        showDialog(t, fresh)
      }

      ctx.effect(() => {
        const unsubscribe = sessions.list.subscribe(checkOnce)
        // Projection frames can land while the page is loading, before the list
        // store has any subscribers; poll briefly so that ordering can never
        // silently swallow the heads-up.
        const poll = setInterval(checkOnce, 2000)
        const stopPolling = setTimeout(clearInterval, 120000, poll)
        return () => {
          unsubscribe()
          clearInterval(poll)
          clearTimeout(stopPolling)
        }
      }, 'turnrewind dialog runner')
    }

    Object.assign(exports, { apply, inject, parseUndoOutput })
    return module.exports
  },
})
