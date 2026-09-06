/**
 * host/service/doctor.ts — /undo --doctor 只读诊断。
 *
 * 生产化运维面：undo 出问题时一条命令自查——git 可用性、工作区资格、账本
 * 规模与恢复围栏、快照仓库健康（refs / alternates）、最近 turn 状态、备份
 * 新旧。全部 best-effort：单节失败不炸整份报告，节内以 error 行呈现。
 */

import type { SnapshotStore } from '../types'
import type { Ledger } from './ledger'
import { existsSync, statSync } from 'node:fs'
import { join } from 'pathe'
import { SNAPSHOT_REF_PREFIX } from '../constants'
import { createSnapshotStore, gitAvailable, runGitText } from './git-snapshot'
import { getLatestTurnSummary, listRecoveryWorkspaces } from './ledger'
import { workspaceForSession, workspaceIssue, workspaceKeyFor } from './undo'

async function describeSnapshotRepo(store: SnapshotStore): Promise<string> {
  const repoDir = store.repoDir
  if (!existsSync(join(repoDir, 'HEAD')))
    return `${repoDir} — not created yet (no turn captured for this workspace)`
  let refCount = 0
  try {
    const refs = await runGitText(repoDir, store.workspaceDir, ['for-each-ref', '--format=%(refname)', SNAPSHOT_REF_PREFIX])
    refCount = refs.split('\n').filter(Boolean).length
  }
  catch (error) {
    return `${repoDir} — error listing refs: ${String((error as Error).message ?? error)}`
  }
  const alternates = join(repoDir, 'objects', 'info', 'alternates')
  const storage = existsSync(alternates) ? 'borrows source objects (alternates)' : 'self-contained'
  return `${repoDir} — ${refCount} snapshot ref(s), ${storage}`
}

function describeBackup(dataRoot: string): string {
  const backupPath = join(dataRoot, 'ledger.sqlite.bak')
  const stat = statSync(backupPath, { throwIfNoEntry: false })
  if (!stat)
    return `${backupPath} — missing (written on the first host open)`
  const ageHours = Math.round((Date.now() - stat.mtimeMs) / 3600000)
  return `${backupPath} — ${ageHours}h old`
}

/**
 * 汇总一份诊断报告（纯文本，多行）。入参只依赖账本与数据根，agent 仅用于
 * 会话归属与工作区定位；任何一节失败都降级为该节的 error 行。
 */
export async function collectDoctorReport(db: Ledger, dataRoot: string, agent: { session: { id: string, header?: { cwd?: string } } }): Promise<string> {
  const lines: string[] = ['Turn rewind doctor']

  // 1) git 可用性（探测带进程级缓存）。
  try {
    const available = await gitAvailable()
    lines.push(`git: ${available ? 'available' : 'NOT FOUND on PATH (turns run, undo is disabled)'}`)
  }
  catch (error) {
    lines.push(`git: error — ${String((error as Error).message ?? error)}`)
  }

  // 2) 会话工作区资格。
  const workspaceDir = workspaceForSession(agent?.session)
  if (workspaceDir) {
    lines.push(`workspace: ${workspaceDir} (git worktree, eligible)`)
  }
  else {
    const cwd = agent?.session?.header?.cwd
    const issue = typeof cwd === 'string' && cwd.length > 0 ? workspaceIssue(cwd) : undefined
    lines.push(`workspace: NOT ELIGIBLE${issue ? ` — ${issue}` : ' (session has no cwd)'}`)
  }

  // 3) 账本规模与恢复围栏。
  try {
    const counts = {
      turns: Number(db.prepare('SELECT COUNT(*) AS n FROM turns').get()?.n ?? 0),
      operations: Number(db.prepare('SELECT COUNT(*) AS n FROM operations').get()?.n ?? 0),
      pendingNotices: Number(db.prepare('SELECT COUNT(*) AS n FROM rewind_notices WHERE status = \'pending\'').get()?.n ?? 0),
      pendingPlans: Number(db.prepare('SELECT COUNT(*) AS n FROM pending_plans WHERE status = \'pending\'').get()?.n ?? 0),
    }
    lines.push(`ledger: healthy (opened with quick_check) — ${counts.turns} turn(s), ${counts.operations} operation(s), ${counts.pendingNotices} pending notice(s), ${counts.pendingPlans} pending plan(s)`)
    const fenced = listRecoveryWorkspaces(db)
    if (fenced.length === 0) {
      lines.push('recovery fence: none')
    }
    else {
      lines.push(`recovery fence: ${fenced.length} workspace(s) BLOCKED — open the recovery panel to resolve`)
      for (const workspace of fenced)
        lines.push(`  - ${workspace.workspace_path ?? workspace.workspace_key}: ${workspace.operations.map(op => `${op.kind} → ${op.target_turn_id}`).join('; ')}`)
    }
  }
  catch (error) {
    lines.push(`ledger: error — ${String((error as Error).message ?? error)}`)
  }

  // 4) 本会话最近一个 turn 的状态。
  try {
    const cwd = agent?.session?.header?.cwd
    const key = workspaceDir ? workspaceKeyFor(workspaceDir) : (typeof cwd === 'string' && cwd.length > 0 ? workspaceKeyFor(cwd) : undefined)
    const latest = key ? getLatestTurnSummary(db, agent.session.id, key) : undefined
    lines.push(`latest turn in this session: ${latest ? `${latest.turn_id} is ${latest.status} (reversible=${latest.reversible})` : 'none recorded'}`)
  }
  catch (error) {
    lines.push(`latest turn: error — ${String((error as Error).message ?? error)}`)
  }

  // 5) 快照仓库健康（工作区未定时跳过）。
  if (workspaceDir) {
    try {
      const store = createSnapshotStore(dataRoot, workspaceDir)
      lines.push(`snapshot repo: ${await describeSnapshotRepo(store)}`)
    }
    catch (error) {
      lines.push(`snapshot repo: error — ${String((error as Error).message ?? error)}`)
    }
  }

  // 6) 备份。
  try {
    lines.push(`ledger backup: ${describeBackup(dataRoot)}`)
  }
  catch (error) {
    lines.push(`ledger backup: error — ${String((error as Error).message ?? error)}`)
  }

  // 首行是标题不加符号；其余顶层行统一加「- 」，缩进子行保留原缩进。
  return lines.map((line, index) => index === 0 || line.startsWith('  ') ? line : `- ${line}`).join('\n')
}
