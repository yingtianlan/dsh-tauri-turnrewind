import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { captureSnapshot, classifyPathChange, createSnapshotStore, currentState, diffAgainstDisk, gitAvailable, probeWorkspace, restorePath, snapshotDiff, snapshotFileDiff, stateAt } from '../lib/core/git-snapshot.js'
import { completeUndoWithNotice, getLatestTurn, insertTurn, openLedger, settleInterruptedTurn, settleTurn } from '../lib/core/ledger.js'

it('captures and restores modified, added, and deleted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'modified.txt'), 'before')
    await writeFile(join(workspace, 'deleted.txt'), 'to delete')

    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/test-before', 'before')

    await writeFile(join(workspace, 'modified.txt'), 'after')
    await rm(join(workspace, 'deleted.txt'))
    await writeFile(join(workspace, 'added.txt'), 'new')
    const after = await captureSnapshot(store, 'refs/turnrewind/test-after', 'after', before.commit)

    assert.deepEqual((await snapshotDiff(store, before.commit, after.commit)).sort(), ['added.txt', 'deleted.txt', 'modified.txt'])
    assert.notEqual((await stateAt(store, before.commit, 'modified.txt')).digest, (await stateAt(store, after.commit, 'modified.txt')).digest)

    await restorePath(store, before.commit, 'modified.txt')
    await restorePath(store, before.commit, 'deleted.txt')
    await restorePath(store, before.commit, 'added.txt')

    assert.equal(await readFile(join(workspace, 'modified.txt'), 'utf8'), 'before')
    assert.equal(await readFile(join(workspace, 'deleted.txt'), 'utf8'), 'to delete')
    await assert.rejects(stat(join(workspace, 'added.txt')))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('allows sequential undo of an interrupted turn after a later turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-sequence-test-'))
  const workspace = join(root, 'workspace')
  const filesA = ['a-1.txt', 'a-2.txt']
  const filesB = ['b-1.txt', 'b-2.txt']
  const db = openLedger(join(root, 'ledger'))
  try {
    await mkdir(workspace, { recursive: true })
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const beforeA = await captureSnapshot(store, 'refs/turnrewind/a-before', 'A before')
    for (const file of filesA) await writeFile(join(workspace, file), 'A')
    const afterA = await captureSnapshot(store, 'refs/turnrewind/a-after', 'A after', beforeA.commit)
    insertTurn(db, {
      turnId: 'session:A',
      sessionId: 'session',
      workspaceKey: workspace.toLowerCase(),
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/a-before',
    })
    settleInterruptedTurn(db, 'session:A', 'refs/turnrewind/a-after', 'interrupted')

    const beforeB = await captureSnapshot(store, 'refs/turnrewind/b-before', 'B before', afterA.commit)
    for (const file of filesB) await writeFile(join(workspace, file), 'B')
    const afterB = await captureSnapshot(store, 'refs/turnrewind/b-after', 'B after', beforeB.commit)
    insertTurn(db, {
      turnId: 'session:B',
      sessionId: 'session',
      workspaceKey: workspace.toLowerCase(),
      startedAt: '2026-01-01T00:01:00.000Z',
      beforeRef: 'refs/turnrewind/b-before',
    })
    settleTurn(db, 'session:B', 'refs/turnrewind/b-after')

    for (const file of await snapshotDiff(store, beforeB.commit, afterB.commit)) await restorePath(store, beforeB.commit, file)
    completeUndoWithNotice(db, 'session:B', {
      noticeId: 'notice-b',
      sessionId: 'session',
      workspaceKey: workspace.toLowerCase(),
      targetTurnId: 'session:B',
      paths: filesB,
      createdAt: '2026-01-01T00:02:00.000Z',
    })
    assert.equal(getLatestTurn(db, 'session', workspace.toLowerCase()).turn_id, 'session:A')

    for (const file of await snapshotDiff(store, beforeA.commit, afterA.commit)) await restorePath(store, beforeA.commit, file)
    for (const file of [...filesA, ...filesB]) await assert.rejects(stat(join(workspace, file)))
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('handles non-ASCII paths without reporting a false restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-unicode-test-'))
  const workspace = join(root, 'workspace')
  const fileName = '新建文本文档.txt'
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, fileName), 'before')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/unicode-before', 'before')
    await writeFile(join(workspace, fileName), 'after')
    const after = await captureSnapshot(store, 'refs/turnrewind/unicode-after', 'after', before.commit)
    assert.deepEqual(await snapshotDiff(store, before.commit, after.commit), [fileName])
    await restorePath(store, before.commit, fileName)
    assert.equal(await readFile(join(workspace, fileName), 'utf8'), 'before')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('does not treat CRLF conversion as a file conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-crlf-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'line-endings.txt'), 'before\nline\n')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/crlf-before', 'before')
    await writeFile(join(workspace, 'line-endings.txt'), 'after\nline\n')
    const after = await captureSnapshot(store, 'refs/turnrewind/crlf-after', 'after', before.commit)
    await writeFile(join(workspace, 'line-endings.txt'), 'after\r\nline\r\n')
    assert.equal(currentState(workspace, 'line-endings.txt').digest, (await stateAt(store, after.commit, 'line-endings.txt')).digest)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('classifies path changes and produces codex-style diffs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-diff-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'modified.txt'), 'one\ntwo\n')
    await writeFile(join(workspace, 'deleted.txt'), 'gone\n')

    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/diff-before', 'before')
    await writeFile(join(workspace, 'modified.txt'), 'one\nTWO\n')
    await rm(join(workspace, 'deleted.txt'))
    await writeFile(join(workspace, 'created.txt'), 'fresh\n')
    const after = await captureSnapshot(store, 'refs/turnrewind/diff-after', 'after', before.commit)

    assert.equal(await classifyPathChange(store, before.commit, after.commit, 'modified.txt'), 'modified')
    assert.equal(await classifyPathChange(store, before.commit, after.commit, 'created.txt'), 'created')
    assert.equal(await classifyPathChange(store, before.commit, after.commit, 'deleted.txt'), 'deleted')

    // The undo diff is the reverse of the turn's change.
    const undoDiff = await snapshotFileDiff(store, after.commit, before.commit, 'modified.txt')
    assert.match(undoDiff, /-TWO/u)
    assert.match(undoDiff, /\+two/u)

    // Disk still matches the snapshot: no human changes to report.
    assert.equal(await diffAgainstDisk(store, after.commit, 'modified.txt'), '')
    // A human edit after the turn shows up as what an undo would overwrite.
    await writeFile(join(workspace, 'modified.txt'), 'one\nHUMAN\n')
    const conflictDiff = await diffAgainstDisk(store, after.commit, 'modified.txt')
    assert.match(conflictDiff, /-TWO/u)
    assert.match(conflictDiff, /\+HUMAN/u)
    // A file deleted after the turn diffs against the empty blob.
    await rm(join(workspace, 'modified.txt'))
    assert.match(await diffAgainstDisk(store, after.commit, 'modified.txt'), /-one/u)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('truncates long unified diffs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-truncate-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'big.txt'), 'old\n')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/truncate-before', 'before')
    const lines = Array.from({ length: 500 }, (_, index) => `line-${index}`).join('\n')
    await writeFile(join(workspace, 'big.txt'), `${lines}\n`)
    const after = await captureSnapshot(store, 'refs/turnrewind/truncate-after', 'after', before.commit)
    const diff = await snapshotFileDiff(store, before.commit, after.commit, 'big.txt', 50)
    assert.ok(diff.split('\n').length <= 52)
    assert.match(diff, /truncated/u)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects paths outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-path-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    assert.throws(() => currentState(workspace, '../outside.txt'), /TURNREWIND_PATH_ESCAPE/)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('probes a small workspace as trackable and refuses oversized / deep ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-probe-'))
  const workspace = join(root, 'ws')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'a.txt'), 'hello')
    await writeFile(join(workspace, 'b.txt'), 'world')
    // ok: 2 small files
    const small = probeWorkspace(workspace)
    assert.equal(small.ok, true)
    assert.equal(small.fileCount, 2)

    // too many files
    for (let i = 0; i < 6; i++) await writeFile(join(workspace, `f${i}.txt`), 'x')
    const many = probeWorkspace(workspace, { maxFileCount: 4 })
    assert.equal(many.ok, false)
    assert.match(many.reason, /file count/)

    // single oversized file
    const big = join(workspace, 'big.bin')
    await writeFile(big, Buffer.alloc(300))
    const large = probeWorkspace(workspace, { maxFileBytes: 100 })
    assert.equal(large.ok, false)
    assert.match(large.reason, /larger than limit/)

    // deep nesting
    let dir = workspace
    for (let i = 0; i < 6; i++) {
      dir = join(dir, 'd')
      await mkdir(dir)
    }
    const deep = probeWorkspace(workspace, { maxDepth: 3 })
    assert.equal(deep.ok, false)
    assert.match(deep.reason, /nesting depth/)

    // excluded dirs (node_modules, .git) are not counted
    await mkdir(join(workspace, 'node_modules'), { recursive: true })
    await writeFile(join(workspace, 'node_modules', 'huge.bin'), Buffer.alloc(1000))
    const withExcluded = probeWorkspace(workspace, { maxFileBytes: 500 })
    assert.equal(withExcluded.ok, true, 'excluded dirs must not be counted')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rebuilds a fresh baseline when the parent snapshot is gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-orphan-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'a.txt'), 'one')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const first = await captureSnapshot(store, 'refs/turnrewind/orphan-first', 'first')

    // Simulate the snapshot repository being wiped out from under the ledger:
    // without the fallback, every later capture would fail on read-tree.
    // The parent is passed by ref name, exactly like the ledger stores it.
    await rm(store.repoDir, { recursive: true, force: true })
    await writeFile(join(workspace, 'a.txt'), 'two')
    const rebuilt = await captureSnapshot(store, 'refs/turnrewind/orphan-second', 'second', 'refs/turnrewind/orphan-first')
    assert.notEqual(rebuilt.commit, first.commit)
    assert.equal((await stateAt(store, rebuilt.commit, 'a.txt')).kind, 'file')

    // The next turn keeps building on the recovered chain.
    await writeFile(join(workspace, 'b.txt'), 'new')
    const third = await captureSnapshot(store, 'refs/turnrewind/orphan-third', 'third', rebuilt.commit)
    assert.deepEqual(await snapshotDiff(store, rebuilt.commit, third.commit), ['b.txt'])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('probes git availability once per process', async () => {
  const first = await gitAvailable()
  const second = await gitAvailable()
  assert.equal(first, second)
  assert.equal(typeof first, 'boolean')
})
