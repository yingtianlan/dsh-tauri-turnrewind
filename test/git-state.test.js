import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, restorePath } from '../src/host/service/git-snapshot'
import { commitAll, gitOutput, initGitWorkspace } from './git-test-utils.js'

/**
 * The full logical state of the user's source repository. If any snapshot or
 * restore command leaked into the real HEAD, branch, index, refs, stash or
 * commit history, one of these fields would drift.
 */
async function sourceRepoState(workspace) {
  return {
    head: await gitOutput(workspace, ['rev-parse', 'HEAD']),
    branch: await gitOutput(workspace, ['branch', '--show-current']),
    symbolicRef: await gitOutput(workspace, ['symbolic-ref', 'HEAD']),
    status: await gitOutput(workspace, ['status', '--porcelain=v1', '-z']),
    index: await gitOutput(workspace, ['ls-files', '-s']),
    staged: await gitOutput(workspace, ['diff', '--cached']),
    refs: await gitOutput(workspace, ['for-each-ref']),
    history: await gitOutput(workspace, ['log', '--oneline', '--all']),
    stash: await gitOutput(workspace, ['stash', 'list']),
  }
}

/**
 * A deliberately dirty repository: one commit, one staged change, one
 * unstaged change on the same file and one untracked file. A clean repo
 * could hide index pollution; this state cannot.
 */
async function setupDirtyWorkspace(root) {
  const workspace = join(root, 'workspace')
  await initGitWorkspace(workspace)
  await writeFile(join(workspace, 'tracked.txt'), 'v1\n')
  await commitAll(workspace, 'initial')
  await writeFile(join(workspace, 'tracked.txt'), 'staged v2\n')
  await gitOutput(workspace, ['add', 'tracked.txt'])
  await writeFile(join(workspace, 'tracked.txt'), 'unstaged v3\n')
  await writeFile(join(workspace, 'untracked.txt'), 'untracked\n')
  return workspace
}

async function workspaceEntries(workspace) {
  return (await readdir(workspace)).filter(entry => entry !== '.git').sort()
}

it('captures snapshots without touching HEAD, branch, index, status, refs or stash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-git-state-'))
  try {
    const workspace = await setupDirtyWorkspace(root)
    const before = await sourceRepoState(workspace)

    const store = createSnapshotStore(join(root, 'data'), workspace)
    const first = await captureSnapshot(store, 'refs/turnrewind/git-state-before', 'before')
    // A second capture with a parent exercises the incremental path; the
    // workspace itself is untouched between captures so the full logical
    // state, including `git status`, must stay byte-identical.
    const second = await captureSnapshot(store, 'refs/turnrewind/git-state-after', 'after', first.commit)
    assert.notEqual(first.commit, second.commit)

    assert.deepEqual(await sourceRepoState(workspace), before)
    assert.deepEqual(await workspaceEntries(workspace), ['tracked.txt', 'untracked.txt'])

    // Snapshot refs live only under refs/turnrewind/ in the private repo...
    const snapshotRefs = await gitOutput(workspace, ['--git-dir', store.repoDir, 'for-each-ref'])
    assert.match(snapshotRefs, /refs\/turnrewind\//)
    assert.doesNotMatch(snapshotRefs, /refs\/(heads|tags|remotes)\//)
    // ...and never leak into the user's ref namespace.
    assert.doesNotMatch(before.refs, /turnrewind/)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('restores worktree files while the index, HEAD, refs and stash stay untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-git-state-restore-'))
  try {
    const workspace = await setupDirtyWorkspace(root)
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const baseline = await captureSnapshot(store, 'refs/turnrewind/restore-before', 'before')
    const stateBefore = await sourceRepoState(workspace)

    // The "turn": rewrite a tracked file and add a new one.
    await writeFile(join(workspace, 'tracked.txt'), 'turn output\n')
    await writeFile(join(workspace, 'turn-output.txt'), 'output\n')
    await captureSnapshot(store, 'refs/turnrewind/restore-after', 'after', baseline.commit)

    await restorePath(store, baseline.commit, 'tracked.txt')
    await restorePath(store, baseline.commit, 'turn-output.txt')

    // The undo restored the pre-turn worktree content ('unstaged v3'), not
    // the staged blob: snapshots capture the filesystem, never the index.
    assert.equal(await readFile(join(workspace, 'tracked.txt'), 'utf8'), 'unstaged v3\n')
    await assert.rejects(stat(join(workspace, 'turn-output.txt')))
    assert.deepEqual(await workspaceEntries(workspace), ['tracked.txt', 'untracked.txt'])

    // The index still holds the staged 'v2' blob, so the porcelain state is
    // byte-identical: same MM entry for tracked.txt, same untracked file.
    assert.deepEqual(await sourceRepoState(workspace), stateBefore)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
