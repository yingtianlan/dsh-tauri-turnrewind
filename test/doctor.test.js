import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { it } from 'vitest'
import { collectDoctorReport } from '../src/host/service/doctor'
import { captureSnapshot, createSnapshotStore, workspaceKey } from '../src/host/service/git-snapshot'
import { createOperation, insertTurn, openLedger, registerWorkspace, settleOperation, settleTurn } from '../src/host/service/ledger'
import { parseUndoInput } from '../src/host/service/undo'
import { commitAll, initGitWorkspace } from './git-test-utils.js'

it('parses --doctor as a standalone flag', () => {
  const alone = parseUndoInput('--doctor')
  assert.ok(!('error' in alone) && alone.doctor)
  const combined = parseUndoInput('--doctor --force')
  assert.ok('error' in combined && /--doctor/.test(combined.error))
})

it('collects a full read-only doctor report for an eligible workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-doctor-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'a.txt'), 'one')
    await commitAll(workspace, 'initial')
    const dataRoot = join(root, 'data')
    const db = openLedger(dataRoot)
    const store = createSnapshotStore(dataRoot, workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/doctor-before', 'before')
    await writeFile(join(workspace, 'a.txt'), 'two')
    await captureSnapshot(store, 'refs/turnrewind/doctor-after', 'after', before.commit)
    registerWorkspace(db, workspaceKey(workspace), workspace, store.repoDir)
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey: workspaceKey(workspace),
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: before.refName,
    })
    settleTurn(db, 'session:1', 'refs/turnrewind/doctor-after')

    const report = await collectDoctorReport(db, dataRoot, { session: { id: 'session', header: { cwd: workspace } } })
    assert.match(report, /^Turn rewind doctor$/mu)
    assert.match(report, /git: available/u)
    assert.match(report, /workspace: .+ \(git worktree, eligible\)/u)
    assert.match(report, /ledger: healthy \(opened with quick_check\) — 1 turn\(s\)/u)
    assert.match(report, /recovery fence: none/u)
    assert.match(report, /latest turn in this session: session:1 is settled \(reversible=1\)/u)
    assert.match(report, /snapshot repo: .+ — 2 snapshot ref\(s\), borrows source objects \(alternates\)/u)
    assert.match(report, /ledger backup: .+h old/u)

    // A fenced workspace surfaces as blocked with its operations.
    createOperation(db, { operationId: 'op-x', kind: 'undo', targetTurnId: 'session:1', requestedAt: '2026-01-01T00:02:00.000Z' })
    settleOperation(db, 'op-x', 'needs-recovery', 'test')
    const fencedReport = await collectDoctorReport(db, dataRoot, { session: { id: 'session', header: { cwd: workspace } } })
    assert.match(fencedReport, /- recovery fence: 1 workspace\(s\) BLOCKED/u)
    assert.match(fencedReport, /undo → session:1/u)
    db.close()
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
