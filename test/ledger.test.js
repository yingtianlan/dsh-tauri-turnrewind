import assert from 'node:assert/strict'
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { it } from 'vitest'
import { acknowledgeRecovery, backupLedger, claimPendingPlan, claimRewindNotices, completeRedoTransaction, completeUndoTransaction, createOperation, createPendingPlan, getLatestAppliedUndo, getLatestSnapshotRef, getLatestTurn, getPendingPlanRow, getPendingPlanStatus, getTurn, insertTurn, listNeedsRecoveryWorkspaces, listRecoveryWorkspaces, listReversibleTurns, markPendingPlanApplied, markPendingPlanCancelled, markTurnSnapshotMissing, openLedger, planPathsDigest, pruneConsumedNotices, prunePendingPlans, queueRewindNotice, recordSkippedTurn, releasePendingPlanClaim, settleInterruptedTurn, settleNoopTurn, settleOperation, settleTurn } from '../src/host/service/ledger'

/** Windows may hold freshly closed sqlite sidecar files briefly: retry, then give up quietly. */
async function cleanupDir(root) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    }
    catch (error) {
      if (attempt >= 4 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code))
        return
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
}

it('persists turn lifecycle and resumes from the latest durable snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-ledger-test-'))
  const db = openLedger(root)
  try {
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/turn-session-1-before',
    })
    settleTurn(db, 'session:1', 'refs/turnrewind/turn-session-1-after')
    assert.equal(getTurn(db, 'session:1').status, 'settled')
    assert.equal(getLatestTurn(db, 'session', 'workspace').turn_id, 'session:1')
    assert.equal(getLatestSnapshotRef(db, 'workspace'), 'refs/turnrewind/turn-session-1-after')

    insertTurn(db, {
      turnId: 'session:2',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:01:00.000Z',
      beforeRef: 'refs/turnrewind/turn-session-2-before',
    })
    settleNoopTurn(db, 'session:2', 'refs/turnrewind/turn-session-2-after')
    assert.equal(getLatestTurn(db, 'session', 'workspace').turn_id, 'session:1')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('marks undo and queues its one-time notice atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-undo-notice-test-'))
  const db = openLedger(root)
  try {
    insertTurn(db, {
      turnId: 'session:undo',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/undo-before',
    })
    settleTurn(db, 'session:undo', 'refs/turnrewind/undo-after')
    createOperation(db, { operationId: 'op-undo', kind: 'undo', targetTurnId: 'session:undo', requestedAt: '2026-01-01T00:00:30.000Z' })
    completeUndoTransaction(db, {
      noticeId: 'notice-undo',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:undo',
      restoredPaths: ['src/reverted.ts'],
      notRestored: [],
      operationId: 'op-undo',
      createdAt: '2026-01-01T00:01:00.000Z',
    })
    assert.equal(getTurn(db, 'session:undo').status, 'undone')
    const notices = claimRewindNotices(db, 'session', 'workspace')
    assert.equal(notices.length, 1)
    assert.equal(notices[0].notice_id, 'notice-undo')
    assert.deepEqual(notices[0].paths, ['src/reverted.ts'])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('merges multiple pending rewind notices and delivers them once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-notice-test-'))
  const db = openLedger(root)
  try {
    queueRewindNotice(db, {
      noticeId: 'notice-one',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:1',
      paths: ['src/old.ts'],
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    queueRewindNotice(db, {
      noticeId: 'notice-two',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:2',
      paths: ['src/new.ts'],
      createdAt: '2026-01-01T00:01:00.000Z',
    })
    const notices = claimRewindNotices(db, 'session', 'workspace')
    assert.equal(notices.length, 2)
    assert.deepEqual(notices.map(notice => notice.notice_id), ['notice-one', 'notice-two'])
    assert.deepEqual(notices.map(notice => notice.turns), [['session:1'], ['session:2']])
    assert.deepEqual(notices.map(notice => notice.paths), [['src/old.ts'], ['src/new.ts']])
    assert.deepEqual(claimRewindNotices(db, 'session', 'workspace'), [])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('never double-claims notices across concurrent ledger connections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-notice-race-'))
  // Two connections stand in for two host processes sharing one ledger file:
  // the claim is a BEGIN IMMEDIATE transaction, so the reader cannot observe
  // a pending batch that another claimer is about to consume.
  const first = openLedger(root)
  const second = openLedger(root)
  try {
    queueRewindNotice(first, {
      noticeId: 'notice-race',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:1',
      paths: ['src/only.ts'],
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const claimedByFirst = claimRewindNotices(first, 'session', 'workspace')
    assert.equal(claimedByFirst.length, 1)
    assert.equal(claimedByFirst[0].notice_id, 'notice-race')
    // The second connection must see the consumed state, not a stale
    // pre-transaction snapshot of the same pending row.
    assert.deepEqual(claimRewindNotices(second, 'session', 'workspace'), [])
    assert.deepEqual(claimRewindNotices(second, 'session', 'workspace'), [])
  }
  finally {
    first.close()
    second.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps cancelled plans archived across newer previews and past their TTL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-plan-archive-'))
  const db = openLedger(root)
  try {
    const planA = createPendingPlan(db, {
      sessionId: 'session',
      workspaceKey: 'workspace',
      turnId: 'session:1',
      paths: ['a.txt'],
      beforeRef: 'refs/turnrewind/turn-session-1-before',
      afterRef: 'refs/turnrewind/turn-session-1-after',
    })
    assert.equal(markPendingPlanCancelled(db, planA, 'session'), true)

    // A newer preview archives only the pending predecessor: the user's
    // explicit dismissal stays 'cancelled' — refresh must reproduce it.
    const planB = createPendingPlan(db, {
      sessionId: 'session',
      workspaceKey: 'workspace',
      turnId: 'session:2',
      paths: ['b.txt'],
      beforeRef: 'refs/turnrewind/turn-session-2-before',
      afterRef: 'refs/turnrewind/turn-session-2-after',
    })
    assert.equal(getPendingPlanStatus(db, planA, 'session')?.status, 'cancelled')

    // Past-TTL sweeping (startup or lazy) flips only pending rows.
    db.prepare('UPDATE pending_plans SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString())
    prunePendingPlans(db)
    assert.equal(getPendingPlanStatus(db, planA, 'session')?.status, 'cancelled')
    assert.equal(getPendingPlanStatus(db, planB, 'session')?.status, 'expired')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('backs up a healthy ledger and refuses a corrupt one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-ledger-bak-'))
  try {
    const db = openLedger(root)
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/turn-session-1-before',
    })
    // Open-time backup predates this insert: force a second snapshot so the
    // .bak carries the row (the 24h TTL would otherwise skip it).
    backupLedger(db, join(root, 'ledger.sqlite'), { force: true })
    db.close()

    const backupPath = join(root, 'ledger.sqlite.bak')
    assert.equal(existsSync(backupPath), true)

    // The documented recovery path: a corrupt ledger is replaced by its
    // backup and opens cleanly (schema valid, rows from the backup remain).
    const corrupt = 'this is not a sqlite database, just garbage bytes'.repeat(64)
    writeFileSync(join(root, 'ledger.sqlite'), corrupt)
    assert.throws(() => openLedger(root), /TURNREWIND_LEDGER_CORRUPT|database/u)
    copyFileSync(backupPath, join(root, 'ledger.sqlite'))
    const restored = openLedger(root)
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 1)
    restored.close()
  }
  finally {
    // Windows may briefly hold freshly closed sqlite sidecar files, and the
    // temp dir removal can hit EBUSY/EPERM long after every close: swallow —
    // a leaked temp dir is harmless, a masked assertion is not.
    await cleanupDir(root).catch(() => {})
  }
})

it('lists fenced workspaces for recovery and lifts the fence on acknowledgement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-recovery-'))
  const db = openLedger(root)
  try {
    // A turn whose undo landed needs-recovery (transaction failure path).
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey: 'c:\\proj\\one',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/turn-session-1-before',
    })
    settleTurn(db, 'session:1', 'refs/turnrewind/turn-session-1-after')
    createOperation(db, { operationId: 'op-one', kind: 'undo', targetTurnId: 'session:1', requestedAt: '2026-01-01T00:01:00.000Z' })
    // The transaction-failure path leaves the operation needs-recovery.
    settleOperation(db, 'op-one', 'needs-recovery', 'test: interrupted')
    // Account for the workspace so the recovery row carries its path.
    db.prepare(`INSERT INTO workspaces(workspace_key, workspace_path, snapshot_repo, created_at) VALUES ('c:\\proj\\one', 'C:\\Proj\\One', 'repo.git', '2026-01-01T00:00:00.000Z')`).run()

    const fenced = listRecoveryWorkspaces(db)
    assert.equal(fenced.length, 1)
    assert.equal(fenced[0].workspace_key, 'c:\\proj\\one')
    assert.equal(fenced[0].workspace_path, 'C:\\Proj\\One')
    assert.equal(fenced[0].operations.length, 1)
    assert.equal(fenced[0].operations[0].operation_id, 'op-one')

    // Acknowledgement is a terminal rewrite: the fence queries (which only
    // match needs-recovery) stop matching, and the audit row stays annotated.
    assert.equal(acknowledgeRecovery(db, 'c:\\proj\\one'), 1)
    assert.deepEqual(listRecoveryWorkspaces(db), [])
    const row = db.prepare(`SELECT outcome, error FROM operations WHERE operation_id = 'op-one'`).get()
    assert.equal(row.outcome, 'recovery-acknowledged')
    assert.match(row.error, /recovery acknowledged at /u)
    // Repeat acknowledgement is a no-op (already terminal).
    assert.equal(acknowledgeRecovery(db, 'c:\\proj\\one'), 0)
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('records a skipped turn with a single unsupported-workspace heads-up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-skip-test-'))
  const db = openLedger(root)
  try {
    const turn = {
      sessionId: 'session',
      workspaceKey: 'c:\\users\\someone',
      startedAt: '2026-01-01T00:00:00.000Z',
    }
    recordSkippedTurn(db, { ...turn, turnId: 'session:1' }, 'TURNREWIND_WORKSPACE_UNSUPPORTED: home directory')
    recordSkippedTurn(db, { ...turn, turnId: 'session:2' }, 'TURNREWIND_WORKSPACE_UNSUPPORTED: home directory')
    assert.equal(getTurn(db, 'session:1').status, 'skipped')
    assert.equal(getTurn(db, 'session:2').status, 'skipped')
    const notices = claimRewindNotices(db, 'session', 'c:\\users\\someone')
    assert.equal(notices.length, 1)
    assert.equal(notices[0].kind, 'unsupported')
    assert.equal(notices[0].reason, 'TURNREWIND_WORKSPACE_UNSUPPORTED: home directory')
    assert.equal(claimRewindNotices(db, 'session', 'c:\\users\\someone').length, 0)
    recordSkippedTurn(db, { ...turn, turnId: 'session:3' }, 'TURNREWIND_WORKSPACE_TOO_LARGE: budget')
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM rewind_notices WHERE kind = 'unsupported'`).get().count, 1)
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('merges a C-B-A undo sequence into one complete notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-cba-test-'))
  const db = openLedger(root)
  try {
    for (const [turnId, time] of [
      ['session:A', '2026-01-01T00:00:00.000Z'],
      ['session:B', '2026-01-01T00:01:00.000Z'],
      ['session:C', '2026-01-01T00:02:00.000Z'],
    ]) {
      insertTurn(db, {
        turnId,
        sessionId: 'session',
        workspaceKey: 'workspace',
        startedAt: time,
        beforeRef: `${turnId}-before`,
      })
      settleTurn(db, turnId, `${turnId}-after`)
    }
    for (const [turnId, path, time] of [
      ['session:C', 'c.ts', '2026-01-01T00:03:00.000Z'],
      ['session:B', 'b.ts', '2026-01-01T00:04:00.000Z'],
      ['session:A', 'a.ts', '2026-01-01T00:05:00.000Z'],
    ]) {
      createOperation(db, { operationId: `op-${turnId}`, kind: 'undo', targetTurnId: turnId, requestedAt: time })
      completeUndoTransaction(db, {
        noticeId: `notice-${turnId}`,
        sessionId: 'session',
        workspaceKey: 'workspace',
        targetTurnId: turnId,
        restoredPaths: [path],
        notRestored: [],
        operationId: `op-${turnId}`,
        createdAt: time,
      })
    }
    const notices = claimRewindNotices(db, 'session', 'workspace')
    assert.deepEqual(notices.map(notice => notice.turns), [['session:C'], ['session:B'], ['session:A']])
    assert.deepEqual(notices.map(notice => notice.paths), [['c.ts'], ['b.ts'], ['a.ts']])
    assert.deepEqual(claimRewindNotices(db, 'session', 'workspace'), [])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps an interrupted turn reversible when it captured file changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-interrupt-test-'))
  const db = openLedger(root)
  try {
    insertTurn(db, {
      turnId: 'session:settled',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/settled-before',
    })
    settleTurn(db, 'session:settled', 'refs/turnrewind/settled-after')
    insertTurn(db, {
      turnId: 'session:interrupted',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:01:00.000Z',
      beforeRef: 'refs/turnrewind/interrupted-before',
    })
    settleInterruptedTurn(
      db,
      'session:interrupted',
      'refs/turnrewind/interrupted-after',
      'agent became idle after interruption',
    )
    assert.equal(getTurn(db, 'session:interrupted').status, 'interrupted')
    assert.equal(getTurn(db, 'session:interrupted').reversible, 1)
    assert.equal(getLatestTurn(db, 'session', 'workspace').turn_id, 'session:interrupted')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('selects an interrupted turn after a later turn is undone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-sequence-test-'))
  const db = openLedger(root)
  try {
    insertTurn(db, {
      turnId: 'session:interrupted',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/interrupted-before',
    })
    settleInterruptedTurn(db, 'session:interrupted', 'refs/turnrewind/interrupted-after', 'interrupted')
    insertTurn(db, {
      turnId: 'session:later',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:01:00.000Z',
      beforeRef: 'refs/turnrewind/later-before',
    })
    settleTurn(db, 'session:later', 'refs/turnrewind/later-after')
    createOperation(db, { operationId: 'op-later', kind: 'undo', targetTurnId: 'session:later', requestedAt: '2026-01-01T00:01:30.000Z' })
    completeUndoTransaction(db, {
      noticeId: 'notice-later',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:later',
      restoredPaths: ['later.txt'],
      notRestored: [],
      operationId: 'op-later',
      createdAt: '2026-01-01T00:02:00.000Z',
    })
    assert.equal(getLatestTurn(db, 'session', 'workspace').turn_id, 'session:interrupted')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('redoes an applied undo and queues a redo notice atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-redo-test-'))
  const db = openLedger(root)
  try {
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey: 'workspace',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/turn-1-before',
    })
    settleTurn(db, 'session:1', 'refs/turnrewind/turn-1-after')
    createOperation(db, {
      operationId: 'op-undo',
      kind: 'undo',
      targetTurnId: 'session:1',
      requestedAt: '2026-01-01T00:01:00.000Z',
      beforeRef: 'refs/turnrewind/operation-op-undo',
    })
    completeUndoTransaction(db, {
      noticeId: 'notice-undo-2',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:1',
      restoredPaths: ['a.ts'],
      notRestored: [],
      operationId: 'op-undo',
      createdAt: '2026-01-01T00:01:00.000Z',
    })
    assert.equal(getTurn(db, 'session:1').status, 'undone')
    assert.equal(getLatestAppliedUndo(db, 'session', 'workspace').operation_id, 'op-undo')

    // The undo notice is delivered first.
    const undoNotices = claimRewindNotices(db, 'session', 'workspace')
    assert.equal(undoNotices.length, 1)
    assert.equal(undoNotices[0].kind, 'undo')

    createOperation(db, {
      operationId: 'op-redo',
      kind: 'redo',
      targetTurnId: 'session:1',
      requestedAt: '2026-01-01T00:02:00.000Z',
      beforeRef: 'refs/turnrewind/redo-op-redo',
    })
    completeRedoTransaction(db, {
      noticeId: 'notice-redo',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:1',
      redoneOperationId: 'op-undo',
      operationId: 'op-redo',
      restoredPaths: ['a.ts'],
      notRestored: [],
      createdAt: '2026-01-01T00:02:00.000Z',
    })
    assert.equal(getTurn(db, 'session:1').status, 'settled')
    assert.equal(getTurn(db, 'session:1').reversible, 1)
    // A redone operation is no longer a redo candidate.
    assert.equal(getLatestAppliedUndo(db, 'session', 'workspace'), undefined)
    // The redo itself is recorded as an applied operation.
    assert.equal(db.prepare('SELECT outcome FROM operations WHERE operation_id = ?').get('op-redo').outcome, 'applied')

    const redoNotices = claimRewindNotices(db, 'session', 'workspace')
    assert.equal(redoNotices.length, 1)
    assert.equal(redoNotices[0].kind, 'redo')
    assert.deepEqual(redoNotices[0].paths, ['a.ts'])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('fences a redo whose undo operation is no longer applied as needs-recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-redo-fence-test-'))
  const db = openLedger(root)
  try {
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey: 'workspace-fence',
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/turn-1-before',
    })
    settleTurn(db, 'session:1', 'refs/turnrewind/turn-1-after')
    createOperation(db, {
      operationId: 'op-undo',
      kind: 'undo',
      targetTurnId: 'session:1',
      requestedAt: '2026-01-01T00:01:00.000Z',
    })
    // The undo transaction completes: turn is undone, old op applied.
    completeUndoTransaction(db, {
      noticeId: 'notice-undo',
      sessionId: 'session',
      workspaceKey: 'workspace-fence',
      targetTurnId: 'session:1',
      restoredPaths: ['a.ts'],
      notRestored: [],
      operationId: 'op-undo',
      createdAt: '2026-01-01T00:01:00.000Z',
    })
    // Consume the legitimate undo notice so the final assertion can require
    // that no ADDITIONAL (redo) notice leaked from the failed transaction.
    assert.equal(claimRewindNotices(db, 'session', 'workspace-fence').length, 1)
    createOperation(db, {
      operationId: 'op-redo',
      kind: 'redo',
      targetTurnId: 'session:1',
      requestedAt: '2026-01-01T00:02:00.000Z',
    })
    // Another writer flipped the old undo operation out from under us: the
    // redo must roll back and fence this workspace via needs-recovery.
    settleOperation(db, 'op-undo', 'rolled_back')
    assert.throws(
      () => completeRedoTransaction(db, {
        noticeId: 'notice-redo',
        sessionId: 'session',
        workspaceKey: 'workspace-fence',
        targetTurnId: 'session:1',
        redoneOperationId: 'op-undo',
        operationId: 'op-redo',
        restoredPaths: ['a.ts'],
        notRestored: [],
        createdAt: '2026-01-01T00:02:00.000Z',
      }),
      /OPERATION_STATE_MISMATCH/u,
    )
    // The redo operation was fenced; the workspace lands in the recovery list.
    assert.equal(db.prepare('SELECT outcome FROM operations WHERE operation_id = ?').get('op-redo').outcome, 'needs-recovery')
    assert.deepEqual(listNeedsRecoveryWorkspaces(db), ['workspace-fence'])
    // Nothing from the failed transaction leaked: turn is still undone, no redo notice.
    assert.equal(getTurn(db, 'session:1').status, 'undone')
    assert.equal(claimRewindNotices(db, 'session', 'workspace-fence').length, 0)
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('lists reversible turns newest-first and marks dead snapshots skipped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-deadref-test-'))
  const db = openLedger(root)
  try {
    for (const [turnId, time] of [
      ['session:1', '2026-01-01T00:00:00.000Z'],
      ['session:2', '2026-01-01T00:01:00.000Z'],
      ['session:3', '2026-01-01T00:02:00.000Z'],
    ]) {
      insertTurn(db, {
        turnId,
        sessionId: 'session',
        workspaceKey: 'workspace',
        startedAt: time,
        beforeRef: `refs/turnrewind/turn-${turnId}-before`,
      })
      settleTurn(db, turnId, `refs/turnrewind/turn-${turnId}-after`)
    }
    createOperation(db, { operationId: 'op-session-3', kind: 'undo', targetTurnId: 'session:3', requestedAt: '2026-01-01T00:02:30.000Z' })
    completeUndoTransaction(db, {
      noticeId: 'notice-3',
      sessionId: 'session',
      workspaceKey: 'workspace',
      targetTurnId: 'session:3',
      restoredPaths: ['a.txt'],
      notRestored: [],
      operationId: 'op-session-3',
      createdAt: '2026-01-01T00:03:00.000Z',
    })
    const candidates = listReversibleTurns(db, 'session', 'workspace')
    assert.deepEqual(candidates.map(turn => turn.turn_id), ['session:2', 'session:1'])
    markTurnSnapshotMissing(db, 'session:2')
    assert.equal(getTurn(db, 'session:2').reversible, 0)
    assert.match(getTurn(db, 'session:2').error, /snapshot repository was wiped/)
    assert.deepEqual(listReversibleTurns(db, 'session', 'workspace').map(turn => turn.turn_id), ['session:1'])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('claims a pending plan exactly once and serializes cancel/apply outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-plan-claim-test-'))
  const db = openLedger(root)
  try {
    const planId = createPendingPlan(db, {
      sessionId: 'session',
      workspaceKey: 'workspace',
      turnId: 'session:1',
      paths: ['a.txt'],
      beforeRef: 'refs/turnrewind/turn-1-before',
      afterRef: 'refs/turnrewind/turn-1-after',
    })
    const first = claimPendingPlan(db, planId, 'session')
    assert.equal(first.ok, true)
    if (first.ok) {
      // The preview binding (P1-2) is persisted with the plan.
      assert.equal(first.row.before_ref, 'refs/turnrewind/turn-1-before')
      assert.equal(first.row.after_ref, 'refs/turnrewind/turn-1-after')
      assert.equal(first.row.paths_digest, planPathsDigest(['a.txt']))
    }
    assert.equal(getPendingPlanStatus(db, planId, 'session').status, 'applying')
    assert.equal(claimPendingPlan(db, planId, 'session').ok, false)
    assert.equal(markPendingPlanCancelled(db, planId, 'session'), false)

    releasePendingPlanClaim(db, planId)
    assert.equal(getPendingPlanStatus(db, planId, 'session').status, 'pending')
    const second = claimPendingPlan(db, planId, 'session')
    assert.equal(second.ok, true)
    markPendingPlanApplied(db, planId, 'session', 'applied once')
    assert.deepEqual(getPendingPlanStatus(db, planId, 'session'), { status: 'applied', resultText: 'applied once' })
    assert.equal(claimPendingPlan(db, planId, 'session').ok, false)
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('archives expired plans as expired instead of deleting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-plan-expire-'))
  const db = openLedger(root)
  try {
    const planId = createPendingPlan(db, {
      sessionId: 'session',
      workspaceKey: 'workspace',
      turnId: 'session:1',
      paths: ['a.txt'],
      beforeRef: 'refs/turnrewind/b',
      afterRef: 'refs/turnrewind/a',
    })
    // Force the plan past its TTL.
    db.prepare('UPDATE pending_plans SET expires_at = \'2020-01-01T00:00:00.000Z\' WHERE plan_id = ?').run(planId)

    // The status poll converts it to expired and reports it (NOT gone):
    // the card keeps its archived view, only execution is refused.
    assert.deepEqual(getPendingPlanStatus(db, planId, 'session'), { status: 'expired', resultText: null })
    assert.equal(db.prepare('SELECT status FROM pending_plans WHERE plan_id = ?').get(planId).status, 'expired')

    // The row lookup for the confirm route also reports expired (not undefined).
    const row = getPendingPlanRow(db, planId)
    assert.equal(row.status, 'expired')

    // Claiming an expired plan is refused with a precise error; the row stays.
    const claim = claimPendingPlan(db, planId, 'session')
    assert.equal(claim.ok, false)
    assert.equal(claim.ok ? 200 : claim.code, 410)
    assert.match(claim.ok ? '' : claim.error, /has expired/u)
    assert.equal(db.prepare('SELECT status FROM pending_plans WHERE plan_id = ?').get(planId).status, 'expired')

    // A newer preview expires the replaced plan (kept as archive) instead of deleting it.
    const secondId = createPendingPlan(db, {
      sessionId: 'session',
      workspaceKey: 'workspace',
      turnId: 'session:2',
      paths: ['b.txt'],
      beforeRef: 'refs/turnrewind/b2',
      afterRef: 'refs/turnrewind/a2',
    })
    db.prepare('UPDATE pending_plans SET expires_at = \'2020-01-01T00:00:00.000Z\' WHERE plan_id = ?').run(secondId)
    prunePendingPlans(db)
    const statuses = db.prepare('SELECT plan_id, status FROM pending_plans WHERE session_id = ? ORDER BY plan_id').all('session')
    assert.equal(statuses.length, 2)
    assert.deepEqual(statuses.map(row2 => row2.status), ['expired', 'expired'])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('fences applying operations as recovery-required on reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-operation-recovery-test-'))
  const first = openLedger(root)
  insertTurn(first, {
    turnId: 'session:applying',
    sessionId: 'session',
    workspaceKey: 'workspace-recovery',
    startedAt: '2026-01-01T00:00:00.000Z',
    beforeRef: 'refs/turnrewind/applying-before',
  })
  settleTurn(first, 'session:applying', 'refs/turnrewind/applying-after')
  createOperation(first, {
    operationId: 'operation-applying',
    kind: 'undo',
    targetTurnId: 'session:applying',
    requestedAt: '2026-01-01T00:01:00.000Z',
    beforeRef: 'refs/turnrewind/operation-before',
  })
  first.close()

  const reopened = openLedger(root)
  try {
    const operation = reopened.prepare('SELECT outcome, error FROM operations WHERE operation_id = ?').get('operation-applying')
    assert.equal(operation.outcome, 'needs-recovery')
    assert.match(operation.error, /restarted while the operation was applying/u)
    assert.deepEqual(listNeedsRecoveryWorkspaces(reopened), ['workspace-recovery'])
  }
  finally {
    reopened.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('marks an interrupted active turn abandoned on reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-recovery-test-'))
  const first = openLedger(root)
  insertTurn(first, {
    turnId: 'session:active',
    sessionId: 'session',
    workspaceKey: 'workspace',
    startedAt: '2026-01-01T00:00:00.000Z',
    beforeRef: 'refs/turnrewind/active-before',
  })
  first.close()
  const reopened = openLedger(root)
  try {
    assert.equal(getTurn(reopened, 'session:active').status, 'abandoned')
    assert.equal(getTurn(reopened, 'session:active').reversible, 0)
  }
  finally {
    reopened.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('prunes only long-consumed notices and keeps the dedup rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-notice-prune-'))
  try {
    const db = openLedger(root)
    db.exec('BEGIN')
    // Old consumed row (past the cutoff) and a fresh consumed row.
    db.prepare(`INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, kind, status, created_at, claimed_at)
      VALUES ('old', 's1', 'ws1', 't1', '[]', '[]', 'undo', 'consumed', ?, ?)`).run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z')
    db.prepare(`INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, kind, status, created_at, claimed_at)
      VALUES ('fresh', 's2', 'ws1', 't2', '[]', '[]', 'undo', 'consumed', ?, ?)`).run(new Date().toISOString(), new Date().toISOString())
    // A pending row must survive regardless of age.
    db.prepare(`INSERT INTO rewind_notices(notice_id, session_id, workspace_key, target_turn_id, turns_json, paths_json, kind, status, created_at)
      VALUES ('pending', 's3', 'ws1', 't3', '[]', '[]', 'unsupported', 'pending', '2020-01-01T00:00:00.000Z')`).run()
    db.exec('COMMIT')

    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const removed = pruneConsumedNotices(db)
    assert.equal(removed, 1)
    const survivors = db.prepare('SELECT notice_id FROM rewind_notices ORDER BY notice_id').all().map(row => row.notice_id)
    assert.deepEqual(survivors, ['fresh', 'pending'])
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})

it('completes an interrupted turn undo in one transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-interrupted-undo-'))
  const db = openLedger(root)
  try {
    insertTurn(db, { turnId: 'session:9', sessionId: 'session', workspaceKey: 'ws', startedAt: '2026-01-01T00:00:00.000Z', beforeRef: 'refs/turnrewind/i1-before' })
    settleInterruptedTurn(db, 'session:9', 'refs/turnrewind/i1-after', 'turn ended with error')
    createOperation(db, { operationId: 'op-int', kind: 'undo', targetTurnId: 'session:9', requestedAt: '2026-01-01T00:00:00.000Z', beforeRef: 'refs/turnrewind/op-before' })

    const outcome = completeUndoTransaction(db, {
      noticeId: 'n-int',
      sessionId: 'session',
      workspaceKey: 'ws',
      targetTurnId: 'session:9',
      restoredPaths: ['a.txt'],
      notRestored: [],
      operationId: 'op-int',
      createdAt: '2026-01-01T00:01:00.000Z',
    })
    assert.equal(outcome, 'undone')
    assert.equal(getTurn(db, 'session:9').status, 'undone')
    const op = db.prepare('SELECT outcome FROM operations WHERE operation_id = ?').get('op-int')
    assert.equal(op.outcome, 'applied')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})

it('surfaces partial restore failures in operation and notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-partial-'))
  const db = openLedger(root)
  try {
    insertTurn(db, { turnId: 'session:p', sessionId: 'session', workspaceKey: 'ws', startedAt: '2026-01-01T00:00:00.000Z', beforeRef: 'refs/turnrewind/p-before' })
    settleTurn(db, 'session:p', 'refs/turnrewind/p-after')
    createOperation(db, { operationId: 'op-p', kind: 'undo', targetTurnId: 'session:p', requestedAt: '2026-01-01T00:00:00.000Z' })

    completeUndoTransaction(db, {
      noticeId: 'n-p',
      sessionId: 'session',
      workspaceKey: 'ws',
      targetTurnId: 'session:p',
      restoredPaths: ['a.txt'],
      notRestored: [{ path: 'big.bin', reason: 'over the size limit' }],
      operationId: 'op-p',
      createdAt: '2026-01-01T00:01:00.000Z',
    })
    const op = db.prepare('SELECT outcome, error FROM operations WHERE operation_id = ?').get('op-p')
    assert.equal(op.outcome, 'applied')
    assert.match(op.error, /big\.bin \(over the size limit\)/)
    const notice = db.prepare('SELECT paths_json FROM rewind_notices WHERE notice_id = ?').get('n-p')
    const paths = JSON.parse(notice.paths_json)
    assert.deepEqual(paths.sort(), ['a.txt', 'big.bin'])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})

it('lands needs-recovery when the turn state drifted after files were restored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-mismatch-'))
  const db = openLedger(root)
  try {
    insertTurn(db, { turnId: 'session:m', sessionId: 'session', workspaceKey: 'ws', startedAt: '2026-01-01T00:00:00.000Z', beforeRef: 'refs/turnrewind/m-before' })
    createOperation(db, { operationId: 'op-m', kind: 'undo', targetTurnId: 'session:m', requestedAt: '2026-01-01T00:00:00.000Z' })
    // Simulate the crash window: files restored on disk, but the turn state
    // drifted elsewhere. No turn rows may update.
    db.prepare('UPDATE turns SET status = \'failed\' WHERE turn_id = ?').run('session:m')

    assert.throws(
      () => completeUndoTransaction(db, {
        noticeId: 'n-m',
        sessionId: 'session',
        workspaceKey: 'ws',
        targetTurnId: 'session:m',
        restoredPaths: ['a.txt'],
        notRestored: [],
        operationId: 'op-m',
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
      /TURN_STATE_MISMATCH/,
    )
    const op = db.prepare('SELECT outcome, error FROM operations WHERE operation_id = ?').get('op-m')
    assert.equal(op.outcome, 'needs-recovery')
    assert.match(op.error, /TURN_STATE_MISMATCH/)
    const notices = db.prepare('SELECT COUNT(*) c FROM rewind_notices').get().c
    assert.equal(notices, 0)
    assert.deepEqual(listNeedsRecoveryWorkspaces(db), ['ws'])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})
