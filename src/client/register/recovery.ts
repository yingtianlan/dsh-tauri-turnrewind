/**
 * client/register/recovery.ts — 恢复面板：被围 workspace 的检查与解锁。
 *
 * 数据与动作经 /api/turnrewind/recovery（GET）与 /recovery/resolve（POST）：
 * 两个解锁动作由宿主路由承担——acknowledge（用户确认已人工检查，保留历史）
 * 与 purge（清除该工作区的 rewind 数据）。本模块只负责 DOM 呈现与调用；
 * 「打开恢复面板」入口由不可用弹窗在 reason 命中 TURNREWIND_RECOVERY_REQUIRED
 * 时提供（apply() 注入回调，避免模块互相依赖）。
 */

import type { RecoveryWorkspaceInfo, Translate } from '../types'
import { TURNREWIND_CLASS_PREFIX, TURNREWIND_HTTP_BASE } from '../constants'
import { bindModalA11y } from '../utils/modal-a11y'

interface RecoveryElements {
  backdrop: HTMLDivElement
  card: HTMLDivElement
  title: HTMLDivElement
  intro: HTMLDivElement
  list: HTMLDivElement
  error: HTMLDivElement
  closeButton: HTMLButtonElement
}

let recovery: RecoveryElements | undefined
let a11y: ReturnType<typeof bindModalA11y> | undefined

function ensureRecoveryDialog(): RecoveryElements {
  if (recovery)
    return recovery
  // HMR 交错防护：安装前清残留 backdrop（与 dialog.ts 同规则，类名独立）。
  for (const stale of document.querySelectorAll(`.${TURNREWIND_CLASS_PREFIX}-recovery-backdrop`))
    stale.remove()
  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'presentation')
  backdrop.className = `${TURNREWIND_CLASS_PREFIX}-recovery-backdrop`
  backdrop.dataset.visible = 'false'

  const card = document.createElement('div')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.className = `${TURNREWIND_CLASS_PREFIX}-recovery-card`

  const title = document.createElement('div')
  title.className = `${TURNREWIND_CLASS_PREFIX}-recovery-title`

  const intro = document.createElement('div')
  intro.className = `${TURNREWIND_CLASS_PREFIX}-recovery-intro`

  const list = document.createElement('div')
  list.className = `${TURNREWIND_CLASS_PREFIX}-recovery-list`

  const error = document.createElement('div')
  error.className = `${TURNREWIND_CLASS_PREFIX}-recovery-error`
  error.dataset.visible = 'false'

  const actions = document.createElement('div')
  actions.className = `${TURNREWIND_CLASS_PREFIX}-recovery-actions`
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = `${TURNREWIND_CLASS_PREFIX}-recovery-btn`
  actions.appendChild(closeButton)

  card.append(title, intro, list, error, actions)
  backdrop.appendChild(card)
  document.body.appendChild(backdrop)

  function hide(): void {
    backdrop.dataset.visible = 'false'
  }
  closeButton.addEventListener('click', hide)
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop)
      hide()
  })

  recovery = { backdrop, card, title, intro, list, error, closeButton }
  a11y = bindModalA11y(
    () => recovery?.card ?? null,
    () => recovery?.backdrop.dataset.visible === 'true',
    hide,
  )
  return recovery
}

/** 插件 stop/HMR 时整个子树与 a11y listener 一并移除。 */
export function disposeRecoveryDialog(): void {
  a11y?.release()
  a11y = undefined
  if (!recovery)
    return
  recovery.backdrop.remove()
  recovery = undefined
}

function actionButton(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `${TURNREWIND_CLASS_PREFIX}-recovery-btn${cls}`
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

async function resolveWorkspace(workspaceKey: string, mode: 'acknowledge' | 'purge'): Promise<string | null> {
  const res = await fetch(`${TURNREWIND_HTTP_BASE}/recovery/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceKey, mode }),
  })
  const payload = await res.json().catch(() => ({}) as Record<string, unknown>)
  if (!res.ok)
    return (payload as { error?: string }).error ?? `HTTP ${res.status}`
  return null
}

function renderWorkspaces(t: Translate, container: HTMLDivElement, workspaces: RecoveryWorkspaceInfo[]): void {
  container.textContent = ''
  if (workspaces.length === 0) {
    const empty = document.createElement('div')
    empty.className = `${TURNREWIND_CLASS_PREFIX}-recovery-empty`
    empty.textContent = t('recoveryEmpty')
    container.appendChild(empty)
    return
  }
  for (const workspace of workspaces) {
    const row = document.createElement('div')
    row.className = `${TURNREWIND_CLASS_PREFIX}-recovery-workspace`

    const path = document.createElement('div')
    path.className = `${TURNREWIND_CLASS_PREFIX}-recovery-path`
    path.textContent = workspace.workspace_path ?? workspace.workspace_key
    row.appendChild(path)

    for (const operation of workspace.operations) {
      const op = document.createElement('div')
      op.className = `${TURNREWIND_CLASS_PREFIX}-recovery-op`
      op.textContent = `${operation.kind} → ${operation.target_turn_id}${operation.error ? `: ${operation.error}` : ''}`
      row.appendChild(op)
    }

    const actions = document.createElement('div')
    actions.className = `${TURNREWIND_CLASS_PREFIX}-recovery-actions`
    const run = (mode: 'acknowledge' | 'purge'): void => {
      for (const button of [...actions.querySelectorAll('button')])
        (button as HTMLButtonElement).disabled = true
      void resolveWorkspace(workspace.workspace_key, mode).then((failure) => {
        if (failure)
          showActionError(t, failure)
        else
          void load(t, container)
      })
    }
    actions.appendChild(actionButton(t('recoveryAcknowledge'), '', () => run('acknowledge')))
    actions.appendChild(actionButton(t('recoveryPurge'), ` ${TURNREWIND_CLASS_PREFIX}-recovery-btn-danger`, () => run('purge')))
    row.appendChild(actions)
    container.appendChild(row)
  }
}

function showActionError(t: Translate, message: string): void {
  if (!recovery)
    return
  recovery.error.textContent = `${t('recoveryActionFailed')}${message}`
  recovery.error.dataset.visible = 'true'
}

async function load(t: Translate, container: HTMLDivElement): Promise<void> {
  const res = await fetch(`${TURNREWIND_HTTP_BASE}/recovery`)
  const payload = await res.json().catch(() => ({}) as Record<string, unknown>)
  const workspaces = Array.isArray((payload as { workspaces?: unknown }).workspaces)
    ? (payload as { workspaces: RecoveryWorkspaceInfo[] }).workspaces
    : []
  renderWorkspaces(t, container, workspaces)
}

/** 打开恢复面板并拉取当前围栏状态；动作完成后自动刷新列表。 */
export function openRecoveryDialog(t: Translate): void {
  const el = ensureRecoveryDialog()
  el.title.textContent = t('recoveryTitle')
  el.intro.textContent = t('recoveryIntro')
  el.closeButton.textContent = t('recoveryClose')
  el.error.dataset.visible = 'false'
  el.backdrop.dataset.visible = 'true'
  a11y?.takeFocus()
  void load(t, el.list).catch((error: unknown) => {
    showActionError(t, String((error as Error)?.message ?? error))
  })
}
