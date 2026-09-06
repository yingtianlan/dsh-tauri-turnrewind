import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, restorePath, stateAt } from '../src/host/service/git-snapshot'
import { commitAll, gitOutput, initGitWorkspace, runGit } from './git-test-utils.js'

it('detects source-pruned objects and rebuilds a self-contained baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-gc-test-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'committed.txt'), 'committed\n')
    await commitAll(workspace, 'initial')
    await writeFile(join(workspace, 'borrowed.txt'), 'borrowed content\n')
    // An unreachable source object: present in the source object store but
    // referenced by no ref, exactly like the leftovers of an amend or rebase.
    const borrowedBlob = (await gitOutput(workspace, ['hash-object', '-w', 'borrowed.txt'])).trim()

    const store = createSnapshotStore(join(root, 'data'), workspace)
    const first = await captureSnapshot(store, 'refs/turnrewind/gc-before', 'before')
    // The blob was borrowed through alternates instead of being copied.
    assert.equal((await stateAt(store, first.commit, 'borrowed.txt')).kind, 'file')
    assert.equal(existsSync(join(store.repoDir, 'objects', 'info', 'alternates')), true)
    await gitOutput(workspace, ['--git-dir', store.repoDir, 'cat-file', '-e', `${first.commit}:borrowed.txt`])

    // The turn: rewrite one file and delete the borrowed one.
    await writeFile(join(workspace, 'committed.txt'), 'changed\n')
    await rm(join(workspace, 'borrowed.txt'))
    // The source repository prunes its unreachable objects. Files still on
    // disk get their blobs re-written locally on the next capture (read-tree
    // seeds a stat-less index, so git add re-hashes everything), but a
    // deleted file's borrowed blob is never re-written: only the parent
    // chain still references it.
    await runGit(workspace, ['gc', '--quiet', '--prune=now'])
    await assert.rejects(() => gitOutput(workspace, ['cat-file', '-t', borrowedBlob]))
    // Reads of the old snapshot now break: the borrowed blob is gone everywhere.
    await assert.rejects(() => stateAt(store, first.commit, 'borrowed.txt'))

    // The next capture detects the hole through the parent chain and heals
    // into a self-contained store.
    const second = await captureSnapshot(store, 'refs/turnrewind/gc-after', 'after', 'refs/turnrewind/gc-before')
    assert.notEqual(second.commit, first.commit)
    assert.equal(existsSync(join(store.repoDir, 'objects', 'info', 'alternates')), false)
    assert.equal((await stateAt(store, second.commit, 'committed.txt')).kind, 'file')
    assert.equal((await stateAt(store, second.commit, 'borrowed.txt')).kind, 'absent')

    // Later captures stay self-contained and keep reading without the source.
    const third = await captureSnapshot(store, 'refs/turnrewind/gc-third', 'third', 'refs/turnrewind/gc-after')
    assert.equal((await stateAt(store, third.commit, 'committed.txt')).kind, 'file')
    await restorePath(store, third.commit, 'committed.txt')
    assert.equal(await readFile(join(workspace, 'committed.txt'), 'utf8'), 'changed\n')

    // The healed store physically owns its objects: with no alternates file
    // the snapshot chain no longer depends on the source repository's
    // object store at all.
    const objects = await readdir(join(store.repoDir, 'objects'), { withFileTypes: true })
    assert.equal(existsSync(join(store.repoDir, 'objects', 'info', 'alternates')), false)
    assert.ok(objects.some(entry => entry.isDirectory() && entry.name !== 'info'))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
