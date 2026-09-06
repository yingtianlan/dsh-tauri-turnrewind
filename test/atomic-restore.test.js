import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'pathe'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, restoreCrashedSwaps, restorePath, stateAt } from '../src/host/service/git-snapshot'
import { initGitWorkspace } from './git-test-utils.js'

it('restores without leaving any swap debris', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-atomic-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'a.txt'), 'v1\n')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const before = await captureSnapshot(store, 'refs/turnrewind/atomic-1', 'before')
    await writeFile(join(workspace, 'a.txt'), 'v2\n')
    await captureSnapshot(store, 'refs/turnrewind/atomic-2', 'after', 'refs/turnrewind/atomic-1')

    await restorePath(store, before.commit, 'a.txt')
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'v1\n')
    // No .bak, no .tmp anywhere in the workspace after a clean restore.
    const leftovers = (await readdir(join(workspace))).filter(name => name.includes('turnrewind'))
    assert.deepEqual(leftovers, [])
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})

it('the startup sweep resurrects a target lost mid-swap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-atomic-bak-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'a.txt'), 'old content\n')
    // Simulate the crash window: the target was renamed aside, the second
    // rename never happened, so only the .bak exists.
    await mkdir(join(workspace, 'nested'), { recursive: true })
    await writeFile(join(workspace, 'nested', 'b.txt'), 'nested old\n')
    await rename(join(workspace, 'a.txt'), join(workspace, 'a.txt.turnrewind-restore.bak'))
    await rename(join(workspace, 'nested', 'b.txt'), join(workspace, 'nested', 'b.txt.turnrewind-restore.bak'))
    assert.equal(existsSync(join(workspace, 'a.txt')), false)

    const resurrected = restoreCrashedSwaps(workspace)
    assert.deepEqual(resurrected.map(path => path.split(sep).join('/')).sort(), ['a.txt', 'nested/b.txt'])
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'old content\n')
    assert.equal(await readFile(join(workspace, 'nested', 'b.txt'), 'utf8'), 'nested old\n')
    // The workspace is clean again - no bak files remain.
    assert.equal(existsSync(join(workspace, 'a.txt.turnrewind-restore.bak')), false)
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})

it('the startup sweep removes debris when the target survived', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-atomic-debris-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    // Crash happened after the second rename, before the bak delete: the new
    // content is in place and the bak is redundant.
    await writeFile(join(workspace, 'a.txt'), 'new content\n')
    await writeFile(join(workspace, 'a.txt.turnrewind-restore.bak'), 'old content\n')

    const resurrected = restoreCrashedSwaps(workspace)
    assert.deepEqual(resurrected, [])
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'new content\n')
    assert.equal(existsSync(join(workspace, 'a.txt.turnrewind-restore.bak')), false)
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})

it('a leftover .bak never enters a snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-atomic-snap-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'a.txt'), 'a\n')
    // A bak left by a crashed swap sits next to a missing target.
    await writeFile(join(workspace, 'lost.txt.turnrewind-restore.bak'), 'lost old\n')

    const store = createSnapshotStore(join(root, 'data'), workspace)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/atomic-snap', 'snap')
    // The bak must not be tracked: restoring it as a normal path would
    // resurrect debris into the workspace on a later undo.
    assert.equal((await stateAt(store, snapshot.commit, 'lost.txt.turnrewind-restore.bak')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'a.txt')).kind, 'file')
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})
