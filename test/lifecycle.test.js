import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore } from '../lib/core/git-snapshot.js'
import { getTurn, insertTurn, openLedger, settleTurn } from '../lib/core/ledger.js'
import { applyUndo } from '../lib/index.js'

async function setupTurn() {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-lifecycle-test-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'a.txt'), 'v1\n')
  const db = openLedger(join(root, 'ledger'))
  const store = createSnapshotStore(join(root, 'data'), workspace)
  const before = await captureSnapshot(store, 'refs/turnrewind/t1-before', 'before')
  await writeFile(join(workspace, 'a.txt'), 'v2\n')
  await writeFile(join(workspace, 'c.txt'), 'new\n')
  await captureSnapshot(store, 'refs/turnrewind/t1-after', 'after', before.commit)
  insertTurn(db, {
    turnId: 'session:1',
    sessionId: 'session',
    workspaceKey: resolve(workspace).toLowerCase(),
    startedAt: '2026-01-01T00:00:00.000Z',
    beforeRef: 'refs/turnrewind/t1-before',
  })
  settleTurn(db, 'session:1', 'refs/turnrewind/t1-after')
  const runtime = {
    db,
    store,
    workspaceKey: resolve(workspace).toLowerCase(),
    parentRef: 'refs/turnrewind/t1-after',
    undoing: false,
  }
  const invocation = (rawInput = '') => ({
    rawInput,
    agent: { session: { id: 'session', header: { cwd: workspace } } },
  })
  return { root, workspace, db, runtime, active: new Map(), invocation }
}

/** Bare /undo now parks a pending plan; execute it like the ✓ button would. */
async function undoWithConfirm(runtime, active, invocation) {
  const preview = await applyUndo(runtime, active, invocation())
  assert.equal(preview.kind, 'success')
  const planId = /plan ([0-9a-f-]+)/u.exec(preview.text)?.[1]
  assert.ok(planId, 'preview must carry a pending plan id')
  return applyUndo(runtime, active, invocation(`--confirm ${planId}`))
}

it('plans, previews, and applies conflict policies', async () => {
  const { root, workspace, db, runtime, active, invocation } = await setupTurn()
  try {
    // Dry run classifies every path without writing.
    const dryRun = await applyUndo(runtime, active, invocation('--dry-run'))
    assert.equal(dryRun.kind, 'success')
    assert.match(dryRun.text, /modified 1, created 1, deleted 0/u)
    assert.match(dryRun.text, /modified\s+a\.txt/u)
    assert.match(dryRun.text, /created\s+c\.txt/u)
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'v2\n')

    // Preview shows the diff the undo would apply.
    const preview = await applyUndo(runtime, active, invocation('--preview'))
    assert.equal(preview.kind, 'success')
    assert.match(preview.text, /Undo will apply/u)
    assert.match(preview.text, /-v2/u)
    assert.match(preview.text, /\+v1/u)

    // A human edit after the turn blocks the undo and shows what would be overwritten.
    await writeFile(join(workspace, 'a.txt'), 'HUMAN\n')
    const blocked = await applyUndo(runtime, active, invocation())
    assert.equal(blocked.kind, 'error')
    assert.match(blocked.text, /1 conflict/u)
    assert.match(blocked.text, /\+HUMAN/u)
    assert.match(blocked.text, /--skip-conflicts/u)
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'HUMAN\n')

    // --skip-conflicts restores only the clean file and reports the skip.
    const skipped = await applyUndo(runtime, active, invocation('--skip-conflicts'))
    assert.equal(skipped.kind, 'success')
    assert.match(skipped.text, /Skipped 1 conflicted file\(s\): a\.txt/u)
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'HUMAN\n')
    await assert.rejects(stat(join(workspace, 'c.txt')))
    assert.equal(getTurn(db, 'session:1').status, 'undone')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('forces a restore over a conflicted file', async () => {
  const { root, workspace, db, runtime, active, invocation } = await setupTurn()
  try {
    await writeFile(join(workspace, 'a.txt'), 'HUMAN\n')
    const forced = await applyUndo(runtime, active, invocation('--force'))
    assert.equal(forced.kind, 'success')
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'v1\n')
    await assert.rejects(stat(join(workspace, 'c.txt')))
    assert.equal(getTurn(db, 'session:1').status, 'undone')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('round-trips undo and redo', async () => {
  const { root, workspace, db, runtime, active, invocation } = await setupTurn()
  try {
    const undo = await undoWithConfirm(runtime, active, invocation)
    assert.equal(undo.kind, 'success')
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'v1\n')
    await assert.rejects(stat(join(workspace, 'c.txt')))

    const redo = await applyUndo(runtime, active, invocation('--redo'))
    assert.equal(redo.kind, 'success')
    assert.match(redo.text, /re-applied 2 file\(s\)/u)
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'v2\n')
    assert.equal(await readFile(join(workspace, 'c.txt'), 'utf8'), 'new\n')
    assert.equal(getTurn(db, 'session:1').status, 'settled')

    // The turn is reversible again after the redo.
    const undoAgain = await undoWithConfirm(runtime, active, invocation)
    assert.equal(undoAgain.kind, 'success')
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'v1\n')

    // A second redo targets the new undo operation.
    const redoAgain = await applyUndo(runtime, active, invocation('--redo'))
    assert.equal(redoAgain.kind, 'success')
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'v2\n')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('blocks redo when the disk changed after the undo', async () => {
  const { root, workspace, db, runtime, active, invocation } = await setupTurn()
  try {
    const undo = await undoWithConfirm(runtime, active, invocation)
    assert.equal(undo.kind, 'success')
    await writeFile(join(workspace, 'a.txt'), 'edited-after-undo\n')
    const redo = await applyUndo(runtime, active, invocation('--redo'))
    assert.equal(redo.kind, 'error')
    assert.match(redo.text, /Redo is blocked/u)
    assert.match(redo.text, /\+edited-after-undo/u)
    assert.equal(getTurn(db, 'session:1').status, 'undone')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects invalid option combinations', async () => {
  const { root, db, runtime, active, invocation } = await setupTurn()
  try {
    assert.match((await applyUndo(runtime, active, invocation('--force --skip-conflicts'))).text, /mutually exclusive/u)
    assert.match((await applyUndo(runtime, active, invocation('--redo session:1'))).text, /--redo cannot be combined/u)
    assert.match((await applyUndo(runtime, active, invocation('--subtree session:1'))).text, /not available/u)
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
