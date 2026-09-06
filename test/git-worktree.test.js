import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'pathe'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, gitRef, restorePath, stateAt } from '../src/host/service/git-snapshot'
import { commitAll, gitOutput, initGitWorkspace, runGit } from './git-test-utils.js'

it('isolates linked worktrees of one repository into separate snapshot stores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-worktree-test-'))
  const main = join(root, 'main')
  const linked = join(root, 'linked')
  try {
    await initGitWorkspace(main)
    await writeFile(join(main, 'shared.txt'), 'committed\n')
    await commitAll(main, 'initial')
    await runGit(main, ['worktree', 'add', '--quiet', linked, '-b', 'linked-branch'])
    await writeFile(join(linked, 'linked-only.txt'), 'linked\n')

    const data = join(root, 'data')
    const mainStore = createSnapshotStore(data, main)
    const linkedStore = createSnapshotStore(data, linked)

    // Two worktrees of one repository are two snapshot domains, not one.
    assert.notEqual(mainStore.repoDir, linkedStore.repoDir)
    assert.equal(mainStore.workspaceDir, resolve(main))
    assert.equal(linkedStore.workspaceDir, resolve(linked))

    const beforeStatus = await gitOutput(main, ['status', '--porcelain=v1', '-z'])
    const beforeLinkedStatus = await gitOutput(linked, ['status', '--porcelain=v1', '-z'])
    const mainHead = await gitOutput(main, ['rev-parse', 'HEAD'])
    const linkedHead = await gitOutput(linked, ['rev-parse', 'HEAD'])
    const mainBranch = await gitOutput(main, ['branch', '--show-current'])
    const mainRefs = await gitOutput(main, ['for-each-ref'])

    const mainSnap = await captureSnapshot(mainStore, 'refs/turnrewind/wt-main', 'main worktree')
    const linkedSnap = await captureSnapshot(linkedStore, 'refs/turnrewind/wt-linked', 'linked worktree')

    // Both private repos borrow objects from the same common object store.
    const mainAlternates = (await readFile(join(mainStore.repoDir, 'objects', 'info', 'alternates'), 'utf8')).trim()
    const linkedAlternates = (await readFile(join(linkedStore.repoDir, 'objects', 'info', 'alternates'), 'utf8')).trim()
    assert.equal(mainAlternates, linkedAlternates)
    assert.match(mainAlternates, /main[\\/]\.git[\\/]objects/)

    // Each ref exists only in its own snapshot repository.
    assert.ok(await gitRef(mainStore.repoDir, main, 'refs/turnrewind/wt-main'))
    assert.equal(await gitRef(linkedStore.repoDir, linked, 'refs/turnrewind/wt-main'), undefined)
    assert.ok(await gitRef(linkedStore.repoDir, linked, 'refs/turnrewind/wt-linked'))
    assert.equal(await gitRef(mainStore.repoDir, main, 'refs/turnrewind/wt-linked'), undefined)

    // The linked worktree's own file is captured only by its own store.
    assert.equal((await stateAt(linkedStore, linkedSnap.commit, 'linked-only.txt')).kind, 'file')
    assert.equal((await stateAt(mainStore, mainSnap.commit, 'linked-only.txt')).kind, 'absent')

    // Neither capture touched the user repository: same HEADs, refs and
    // porcelain status in both worktrees.
    assert.equal(await gitOutput(main, ['rev-parse', 'HEAD']), mainHead)
    assert.equal(await gitOutput(linked, ['rev-parse', 'HEAD']), linkedHead)
    assert.equal(await gitOutput(main, ['branch', '--show-current']), mainBranch)
    assert.equal((await gitOutput(linked, ['branch', '--show-current'])).trim(), 'linked-branch')
    assert.equal(await gitOutput(main, ['status', '--porcelain=v1', '-z']), beforeStatus)
    assert.equal(await gitOutput(linked, ['status', '--porcelain=v1', '-z']), beforeLinkedStatus)
    assert.equal(await gitOutput(main, ['for-each-ref']), mainRefs)

    // A session started inside a subdirectory of the linked worktree joins
    // that worktree's snapshot domain, not the main worktree's.
    await mkdir(join(linked, 'sub'))
    const subStore = createSnapshotStore(data, join(linked, 'sub'))
    assert.equal(subStore.repoDir, linkedStore.repoDir)
    assert.equal(subStore.workspaceDir, resolve(linked))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('captures and restores through alternates when the source objects are packed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-worktree-packed-'))
  const main = join(root, 'main')
  const linked = join(root, 'linked')
  try {
    await initGitWorkspace(main)
    await writeFile(join(main, 'packed.txt'), 'packed content\n')
    await commitAll(main, 'initial')
    // Pack the source repository so the reused blobs live in packfiles, the
    // common real-world shape alternates have to read through.
    await runGit(main, ['gc', '--quiet', '--prune=now'])
    await runGit(main, ['worktree', 'add', '--quiet', linked, '-b', 'linked-branch'])

    const store = createSnapshotStore(join(root, 'data'), linked)
    const before = await captureSnapshot(store, 'refs/turnrewind/packed-before', 'before')

    await writeFile(join(linked, 'packed.txt'), 'changed\n')
    const after = await captureSnapshot(store, 'refs/turnrewind/packed-after', 'after', before.commit)
    assert.notEqual(before.commit, after.commit)

    // The baseline blob is the source's packed object, read through the
    // alternates link, and restorePath writes those exact bytes back.
    await restorePath(store, before.commit, 'packed.txt')
    assert.equal(await readFile(join(linked, 'packed.txt'), 'utf8'), 'packed content\n')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
