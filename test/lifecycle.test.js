import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'pathe'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore } from '../src/host/service/git-snapshot'
import { getTurn, insertTurn, openLedger, settleTurn } from '../src/host/service/ledger'
import { applyUndo, waitForTurnBaseline } from '../src/index'
import { initGitWorkspace } from './git-test-utils.js'

async function setupTurn() {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-lifecycle-test-'))
  const workspace = join(root, 'workspace')
  await initGitWorkspace(workspace)
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

it('applies a confirmed undo and reports redo as disabled', { timeout: 30000 }, async () => {
  const { root, workspace, db, runtime, active, invocation } = await setupTurn()
  try {
    const undo = await undoWithConfirm(runtime, active, invocation)
    assert.equal(undo.kind, 'success')
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'v1\n')
    await assert.rejects(stat(join(workspace, 'c.txt')))
    assert.equal(getTurn(db, 'session:1').status, 'undone')

    // Redo is frozen at the parser: even with a clean workspace the entry
    // refuses before any snapshot/conflict work happens.
    const redo = await applyUndo(runtime, active, invocation('--redo'))
    assert.equal(redo.kind, 'error')
    assert.match(redo.text, /temporarily disabled/u)
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'v1\n')
    assert.equal(getTurn(db, 'session:1').status, 'undone')
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects a confirm whose change set drifted from the preview', async () => {
  const { root, workspace, db, runtime, active, invocation } = await setupTurn()
  try {
    const preview = await applyUndo(runtime, active, invocation())
    assert.equal(preview.kind, 'success')
    const planId = /plan ([0-9a-f-]+)/u.exec(preview.text)?.[1]
    assert.ok(planId, 'preview must carry a pending plan id')

    // Simulate plan drift: the persisted binding no longer matches what the
    // confirm recomputes. The confirm must refuse and release the claim.
    db.prepare('UPDATE pending_plans SET paths_digest = ? WHERE plan_id = ?').run('0'.repeat(64), planId)
    const confirmed = await applyUndo(runtime, active, invocation(`--confirm ${planId}`))
    assert.equal(confirmed.kind, 'error')
    assert.match(confirmed.text, /change set no longer matches/u)

    // Nothing was restored and the plan stays pending for a fresh confirm.
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'v2\n')
    const row = db.prepare('SELECT status FROM pending_plans WHERE plan_id = ?').get(planId)
    assert.equal(row.status, 'pending')
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

it('waits for a claimed turn baseline before allowing the next step', async () => {
  let release
  const baseline = new Promise((resolvePromise) => {
    release = resolvePromise
  })
  const active = new Map([
    ['session:7', { baseline: { promise: baseline } }],
  ])
  const controller = new AbortController()
  let continued = false
  const waiting = waitForTurnBaseline(active, 'session', 7, controller.signal).then((result) => {
    continued = true
    assert.equal(result.ok, true)
  })

  await Promise.resolve()
  assert.equal(continued, false)
  release({ ok: true })
  await waiting
  assert.equal(continued, true)
})

it('unblocks an aborted pre-step without cancelling baseline bookkeeping', async () => {
  let release
  const baseline = new Promise((resolvePromise) => {
    release = resolvePromise
  })
  const active = new Map([
    ['session:8', { baseline: { promise: baseline } }],
  ])
  const controller = new AbortController()
  const waiting = waitForTurnBaseline(active, 'session', 8, controller.signal)
  controller.abort(new Error('turn interrupted'))
  await assert.rejects(waiting, /turn interrupted/u)

  let baselineCompleted = false
  const bookkeeping = baseline.then((result) => {
    baselineCompleted = result.ok
  })
  release({ ok: true })
  await bookkeeping
  assert.equal(baselineCompleted, true)
})
