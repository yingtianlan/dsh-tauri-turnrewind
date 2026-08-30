import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, currentState, restorePath, stateAt } from '../lib/core/git-snapshot.js'

it('does not capture common secret files into a snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-secret-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, '.env'), 'TOKEN=do-not-store')
    await writeFile(join(workspace, 'credentials.json'), '{"token":"do-not-store"}')
    await writeFile(join(workspace, 'secrets.yaml'), 'key: do-not-store')
    await writeFile(join(workspace, 'server.pem'), '-----BEGIN')
    await writeFile(join(workspace, 'safe.txt'), 'safe')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/security', 'security')

    assert.equal((await stateAt(store, snapshot.commit, '.env')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'credentials.json')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'secrets.yaml')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'server.pem')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'safe.txt')).kind, 'file')
    const snapshotFiles = await readdir(join(root, 'data', 'snapshots'))
    assert.equal(snapshotFiles.length, 1)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps legitimate source files whose names resemble secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-token-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(join(workspace, 'src'), { recursive: true })
    await mkdir(join(workspace, 'docs'), { recursive: true })
    await writeFile(join(workspace, 'src', 'token.ts'), 'export const token = 1')
    await writeFile(join(workspace, 'src', 'tokenizer.py'), 'def tokenize(): pass')
    await writeFile(join(workspace, 'src', 'secret_manager.js'), 'export const hide = 1')
    await writeFile(join(workspace, 'docs', 'credentials.module.ts'), 'export const config = 1')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/token-source', 'token source')

    // These were silently excluded by the old *token*/*secret*/credentials*
    // globs, so undo could never restore them and the dry-run never showed them.
    assert.equal((await stateAt(store, snapshot.commit, 'src/token.ts')).kind, 'file')
    assert.equal((await stateAt(store, snapshot.commit, 'src/tokenizer.py')).kind, 'file')
    assert.equal((await stateAt(store, snapshot.commit, 'src/secret_manager.js')).kind, 'file')
    assert.equal((await stateAt(store, snapshot.commit, 'docs/credentials.module.ts')).kind, 'file')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses symlinked workspace paths during inspection and restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-symlink-test-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'outside')
    try {
      await symlink(outside, join(workspace, 'linked'))
    }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES')
        return
      throw error
    }
    const store = createSnapshotStore(join(root, 'data'), workspace)
    assert.throws(() => currentState(workspace, 'linked/secret.txt'), /TURNREWIND_SYMLINK_UNSUPPORTED/)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/symlink', 'symlink')
    // The snapshot stores the link itself; paths below it are never tracked.
    assert.equal((await stateAt(store, snapshot.commit, 'linked/secret.txt')).kind, 'absent')
    // Restore refuses to traverse or replace a symlinked path.
    await assert.rejects(
      () => restorePath(store, snapshot.commit, 'linked/secret.txt'),
      /TURNREWIND_SYMLINK_UNSUPPORTED/,
    )
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
