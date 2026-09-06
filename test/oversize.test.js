import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'pathe'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, restorePath, stateAt } from '../src/host/service/git-snapshot'
import { insertTurn, openLedger, settleTurn } from '../src/host/service/ledger'
import { applyUndo } from '../src/index'
import { initGitWorkspace } from './git-test-utils.js'

// 64 MiB + 1 byte: the smallest blob over the restore limit. The buffer is
// mostly zeros so compression keeps the fixture cheap, but the blob size
// still crosses the line.
const OVER_LIMIT_BYTES = 64 * 1024 * 1024 + 1

async function undoWithConfirm(runtime, active, invocation) {
  const preview = await applyUndo(runtime, active, invocation(''))
  assert.equal(preview.kind, 'success')
  const planId = /plan ([0-9a-f-]+)/u.exec(preview.text)?.[1]
  assert.ok(planId, 'preview must carry a pending plan id')
  return applyUndo(runtime, active, invocation(`--confirm ${planId}`))
}

it('reports oversized blobs instead of failing the whole preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-oversize-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'small.txt'), 'small\n')
    // A >64 MiB file: sparse so the fixture stays fast, content only at the end.
    const big = Buffer.alloc(OVER_LIMIT_BYTES)
    big.write('payload at the end', OVER_LIMIT_BYTES - 20)
    await writeFile(join(workspace, 'big.bin'), big)

    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/size-before', 'before')

    // stateAt surfaces the limit as a kind, not an exception: the plan can
    // keep listing other files and mark this one.
    assert.equal((await stateAt(store, before.commit, 'small.txt')).kind, 'file')
    assert.equal((await stateAt(store, before.commit, 'big.bin')).kind, 'tooLarge')

    // restorePath fails for the oversized entry alone...
    await assert.rejects(
      () => restorePath(store, before.commit, 'big.bin'),
      /TURNREWIND_FILE_TOO_LARGE/,
    )
    // ...while other paths in the same commit keep restoring normally.
    await writeFile(join(workspace, 'small.txt'), 'changed\n')
    await restorePath(store, before.commit, 'small.txt')
    assert.equal(await readFile(join(workspace, 'small.txt'), 'utf8'), 'small\n')
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})

it('undoes the other files while reporting the oversized one as not restored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-oversize-undo-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'small.txt'), 'before\n')
    const big = Buffer.alloc(OVER_LIMIT_BYTES)
    big.write('payload at the end', OVER_LIMIT_BYTES - 20)
    await writeFile(join(workspace, 'big.bin'), big)

    const db = openLedger(join(root, 'ledger'))
    const store = createSnapshotStore(join(root, 'data'), workspace)
    await captureSnapshot(store, 'refs/turnrewind/o1-before', 'before')

    // The turn modifies both files; the plan must show the oversize flag.
    await writeFile(join(workspace, 'small.txt'), 'after\n')
    await writeFile(join(workspace, 'big.bin'), big.subarray(0, OVER_LIMIT_BYTES - 1))
    await captureSnapshot(store, 'refs/turnrewind/o1-after', 'after', 'refs/turnrewind/o1-before')
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey: resolve(workspace).toLowerCase(),
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/o1-before',
    })
    settleTurn(db, 'session:1', 'refs/turnrewind/o1-after')

    const runtime = {
      db,
      store,
      workspaceKey: resolve(workspace).toLowerCase(),
      parentRef: 'refs/turnrewind/o1-after',
      undoing: false,
    }
    const invocation = (rawInput = '') => ({
      rawInput,
      agent: { session: { id: 'session', header: { cwd: workspace } } },
    })

    const preview = await applyUndo(runtime, new Map(), invocation(''))
    assert.equal(preview.kind, 'success')
    assert.match(preview.text, /big\.bin \[too large\]/u)
    assert.match(preview.text, /Oversized files \(over the 64 MB restore limit\)/u)

    const result = await undoWithConfirm(runtime, new Map(), invocation)
    assert.equal(result.kind, 'success')
    // The normal file came back; the oversized one failed per-path.
    assert.match(result.text, /restored 1 file\(s\)/u)
    assert.match(result.text, /Not restored \(1 file\(s\)\): big\.bin \(over the size limit\)/u)
    assert.equal(await readFile(join(workspace, 'small.txt'), 'utf8'), 'before\n')
    // The oversized file on disk is untouched (still the turn's output).
    assert.equal((await readFile(join(workspace, 'big.bin'))).length, OVER_LIMIT_BYTES - 1)

    // The turn is settled as undone and the ledger's operation completed.
    const row = db.prepare('SELECT status FROM turns WHERE turn_id = ?').get('session:1')
    assert.equal(row.status, 'undone')
    db.close()
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})
