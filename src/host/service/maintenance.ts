/**
 * host/service/maintenance.ts — 工作区级 turnrewind 数据清除。
 *
 * 只删除本插件自己的 snapshot repo 与账本行；用户 .git、工作区文件与其他
 * workspace 的数据绝不触碰（maintenance.test 钉死）。
 */

import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'
import { join, resolve } from 'pathe'
import { workspaceHash, workspaceKey } from './git-snapshot'
import { openLedger } from './ledger'
import { acquireWorkspaceLockSync } from './workspace-lock'

export function resolveRootDir(explicit?: string): string {
  if (explicit)
    return resolve(explicit)
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
}

export interface PurgeSummary {
  rootDir: string
  repoDir: string
  repoExisted: boolean
  ledger?: { operations: number, notices: number, plans: number, turns: number, workspaces: number }
}

/**
 * Remove every piece of turnrewind data bound to one workspace: the private
 * snapshot repository on disk and all ledger rows that reference it.
 *
 * 跨进程互斥（P1-1）：purge 是破坏性维护操作，与运行中的 Host（快照捕获、
 * undo 等）互斥；workspace 被占用时直接抛 WorkspaceLockBusyError，由 CLI
 * 提示先停止 Host 再执行。
 */
export function purgeWorkspace(rootDir: string, workspaceDir: string): PurgeSummary {
  const workspaceIdentity = workspaceKey(workspaceDir)
  const repoDir = join(rootDir, 'snapshots', `${workspaceHash(workspaceDir)}.git`)
  const summary: PurgeSummary = { rootDir, repoDir, repoExisted: false, ledger: undefined }
  const lock = acquireWorkspaceLockSync(rootDir, workspaceDir)
  try {
    const ledgerPath = join(rootDir, 'ledger.sqlite')
    if (existsSync(ledgerPath)) {
      const db = openLedger(rootDir)
      try {
        db.exec('BEGIN IMMEDIATE')
        const operations = db.prepare('DELETE FROM operations WHERE target_turn_id IN (SELECT turn_id FROM turns WHERE workspace_key = ?)').run(workspaceIdentity)
        const notices = db.prepare('DELETE FROM rewind_notices WHERE workspace_key = ?').run(workspaceIdentity)
        const plans = db.prepare('DELETE FROM pending_plans WHERE workspace_key = ?').run(workspaceIdentity)
        const turns = db.prepare('DELETE FROM turns WHERE workspace_key = ?').run(workspaceIdentity)
        const workspaces = db.prepare('DELETE FROM workspaces WHERE workspace_key = ?').run(workspaceIdentity)
        db.exec('COMMIT')
        summary.ledger = {
          operations: Number(operations.changes),
          notices: Number(notices.changes),
          plans: Number(plans.changes),
          turns: Number(turns.changes),
          workspaces: Number(workspaces.changes),
        }
      }
      finally {
        db.close()
      }
    }

    summary.repoExisted = existsSync(repoDir)
    rmSync(repoDir, { recursive: true, force: true })
    return summary
  }
  finally {
    lock.release()
  }
}
