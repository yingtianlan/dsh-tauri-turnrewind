import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { it } from 'vitest'
import { captureSnapshot, classifyPathChange, createSnapshotStore, currentState, diffAgainstDisk, gitAvailable, probeWorkspace, restorePath, snapshotDiff, snapshotFileDiff, stateAt, workspaceKey } from '../src/host/service/git-snapshot'
import { completeUndoTransaction, createOperation, getLatestTurn, insertTurn, openLedger, settleInterruptedTurn, settleTurn } from '../src/host/service/ledger'
import { initGitWorkspace } from './git-test-utils.js'

it('persists entry mode in snapshots and restores the executable bit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-mode-test-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'run.sh'), '#!/bin/sh\necho hi\n')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/mode-before', 'before')
    // Windows git (core.filemode=false) always records 100644; POSIX records
    // the real mode. Both platforms must surface the mode on the state.
    assert.equal((await stateAt(store, before.commit, 'run.sh')).mode, '100644')

    if (process.platform === 'win32')
      return

    // POSIX round trip: the turn flips the exec bit — a mode-only change that
    // must appear in the diff and be restorable with the bit intact.
    await chmod(join(workspace, 'run.sh'), 0o755)
    const after = await captureSnapshot(store, 'refs/turnrewind/mode-after', 'after', before.commit)
    assert.equal((await stateAt(store, after.commit, 'run.sh')).mode, '100755')
    assert.deepEqual(await snapshotDiff(store, before.commit, after.commit), ['run.sh'])

    // Clear the bit on disk, then restore from the exec snapshot: the mode
    // comes back with the content.
    await chmod(join(workspace, 'run.sh'), 0o644)
    await restorePath(store, after.commit, 'run.sh')
    const restored = await stat(join(workspace, 'run.sh'))
    assert.ok((restored.mode & 0o111) !== 0, 'executable bit must be restored')
    assert.equal((await currentState(workspace, 'run.sh')).mode, '100755')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reports snapshot symlinks as unsupported and refuses to restore them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-symlink-snap-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'target.txt'), 'target\n')
    try {
      await symlink(join(workspace, 'target.txt'), join(workspace, 'link'))
    }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES')
        return
      throw error
    }
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/symlink-snap', 'snap')

    // The snapshot entry has git mode 120000: stateAt reports unsupported
    // instead of masquerading the link target text as file content (P1-3).
    assert.equal((await stateAt(store, snapshot.commit, 'link')).kind, 'unsupported')

    // Restore refuses even when the disk link is gone — the blob is only the
    // link target text and must never be written as a regular file.
    await rm(join(workspace, 'link'))
    await assert.rejects(
      () => restorePath(store, snapshot.commit, 'link'),
      /TURNREWIND_UNSUPPORTED_TARGET.*symlink/u,
    )
    assert.equal(await readFile(join(workspace, 'target.txt'), 'utf8'), 'target\n')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('captures and restores modified, added, and deleted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-test-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
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
    await initGitWorkspace(workspace)
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
    createOperation(db, { operationId: 'op-b', kind: 'undo', targetTurnId: 'session:B', requestedAt: '2026-01-01T00:01:30.000Z' })
    completeUndoTransaction(db, {
      noticeId: 'notice-b',
      sessionId: 'session',
      workspaceKey: workspace.toLowerCase(),
      targetTurnId: 'session:B',
      restoredPaths: filesB,
      notRestored: [],
      operationId: 'op-b',
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
    await initGitWorkspace(workspace)
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
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'line-endings.txt'), 'before\nline\n')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/crlf-before', 'before')
    await writeFile(join(workspace, 'line-endings.txt'), 'after\nline\n')
    const after = await captureSnapshot(store, 'refs/turnrewind/crlf-after', 'after', before.commit)
    await writeFile(join(workspace, 'line-endings.txt'), 'after\r\nline\r\n')
    assert.equal((await currentState(workspace, 'line-endings.txt')).digest, (await stateAt(store, after.commit, 'line-endings.txt')).digest)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('renders a line-ending flip plus appends without phantom duplicate lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-crlf-diff-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    // Pre-turn file with CRLF endings (the Windows checkout norm).
    await writeFile(join(workspace, 'modified3.txt'), '文件 3\r\n用于测试 undo。\r\n')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/crlfdiff-before', 'before')
    // The turn rewrites the same content with LF endings and appends two lines.
    await writeFile(join(workspace, 'modified3.txt'), '文件 3\n用于测试 undo。\n额外追加一行。\n额外追加第二行。')
    const after = await captureSnapshot(store, 'refs/turnrewind/crlfdiff-after', 'after', before.commit)

    // Byte-exact git cannot pair the two visually identical lines; the
    // --ignore-cr-at-eol preview keeps the ending flip from rendering the
    // line as both deleted and added — only the real content change shows.
    const undoDiff = await snapshotFileDiff(store, after.commit, before.commit, 'modified3.txt')
    assert.match(undoDiff, /-额外追加一行。/u)
    assert.match(undoDiff, /-额外追加第二行。/u)
    assert.doesNotMatch(undoDiff, /\+用于测试 undo。/u)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('classifies path changes and produces codex-style diffs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-diff-test-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
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
    await initGitWorkspace(workspace)
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
    await initGitWorkspace(workspace)
    await assert.rejects(() => currentState(workspace, '../outside.txt'), /TURNREWIND_PATH_ESCAPE/)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses to restore or inspect the workspace root itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-root-test-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'a.txt'), 'one')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/root-ref', 'snap')

    // '.' normalizes to the workspace root; a restore there would delete the
    // whole workspace including .git. Both disk-touching entries must refuse.
    await assert.rejects(restorePath(store, snapshot.commit, '.'), /TURNREWIND_PATH_ESCAPE/)
    await assert.rejects(() => currentState(workspace, '.'), /TURNREWIND_PATH_ESCAPE/)
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'one')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses a non-empty directory at an absent path and removes an empty one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-dir-test-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'a.txt'), 'one')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/dir-before', 'before')

    // The turn created a file that the human later replaced by a directory
    // holding unrelated files: undo must not recursively delete that tree.
    await mkdir(join(workspace, 'foo'))
    await writeFile(join(workspace, 'foo', 'user-file.txt'), 'keep me')
    await assert.rejects(
      restorePath(store, before.commit, 'foo'),
      /TURNREWIND_UNSUPPORTED_TARGET.*non-empty directory/u,
    )
    assert.equal(await readFile(join(workspace, 'foo', 'user-file.txt'), 'utf8'), 'keep me')

    // An empty directory holds nothing to lose: the restore removes it
    // (regression pin — rmSync without directory semantics throws EISDIR).
    await mkdir(join(workspace, 'bar'))
    assert.deepEqual(await restorePath(store, before.commit, 'bar'), { path: 'bar', result: 'removed' })
    await assert.rejects(stat(join(workspace, 'bar')), { code: 'ENOENT' })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('accepts Git worktrees and rejects ordinary directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-probe-'))
  const workspace = join(root, 'ws')
  const plain = join(root, 'plain')
  try {
    await initGitWorkspace(workspace)
    await mkdir(plain, { recursive: true })
    const tracked = probeWorkspace(workspace)
    assert.equal(tracked.ok, true)
    assert.equal(tracked.workspaceDir, workspace)
    const rejected = probeWorkspace(plain)
    assert.equal(rejected.ok, false)
    assert.match(rejected.reason, /GIT_REQUIRED/u)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rebuilds a fresh baseline when the parent snapshot is gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-orphan-test-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
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

it('folds path case on case-insensitive platforms only', () => {
  // Windows and macOS (APFS default) treat the two spellings as one
  // workspace; Linux keeps them distinct.
  assert.equal(workspaceKey('C:\Proj\One', 'win32'), workspaceKey('c:\proj\one', 'win32'))
  assert.equal(workspaceKey('/Users/dev/Proj', 'darwin'), workspaceKey('/Users/dev/proj', 'darwin'))
  assert.notEqual(workspaceKey('/home/dev/Proj', 'linux'), workspaceKey('/home/dev/proj', 'linux'))
})
