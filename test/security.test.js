import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'pathe'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, currentState, restorePath, stateAt } from '../src/host/service/git-snapshot'
import { insertTurn, openLedger, settleTurn } from '../src/host/service/ledger'
import { applyUndo } from '../src/index'
import { initGitWorkspace } from './git-test-utils.js'

it('delegates secret-file exclusion to the source repository ignore rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-secret-test-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, '.gitignore'), [
      '.env',
      'credentials.json',
      'secrets.yaml',
      'server.pem',
      'config/credentials.json',
      'nested/secrets.yaml',
      '',
    ].join('\n'))
    await writeFile(join(workspace, '.env'), 'TOKEN=do-not-store')
    await writeFile(join(workspace, 'credentials.json'), '{"token":"do-not-store"}')
    await writeFile(join(workspace, 'secrets.yaml'), 'key: do-not-store')
    await writeFile(join(workspace, 'server.pem'), '-----BEGIN')
    await writeFile(join(workspace, 'unignored.pem'), '-----BEGIN UNIGNORED')
    await writeFile(join(workspace, 'safe.txt'), 'safe')
    await mkdir(join(workspace, 'config'), { recursive: true })
    await mkdir(join(workspace, 'nested'), { recursive: true })
    await writeFile(join(workspace, 'config', 'credentials.json'), '{"token":"nested-do-not-store"}')
    await writeFile(join(workspace, 'nested', 'secrets.yaml'), 'key: nested-do-not-store')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/security', 'security')

    // Git mode dropped the hardcoded secret-name rules: the source repo's own
    // ignore rules decide what a snapshot contains. An unignored secret-named
    // file is deliberately captured — the project opted in by not ignoring it.
    assert.equal((await stateAt(store, snapshot.commit, '.env')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'credentials.json')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'secrets.yaml')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'server.pem')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'config/credentials.json')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'nested/secrets.yaml')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'unignored.pem')).kind, 'file')
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
    await initGitWorkspace(workspace)
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

it('excludes abandoned turnrewind temporary files from snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-temp-file-test-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await mkdir(join(workspace, 'nested'), { recursive: true })
    await writeFile(join(workspace, 'file.turnrewind-01234567-89ab-cdef-0123-456789abcdef.tmp'), 'temporary')
    await writeFile(join(workspace, 'nested', 'file.turnrewind-01234567-89ab-cdef-0123-456789abcdef.tmp'), 'temporary')
    await writeFile(join(workspace, 'kept.txt'), 'kept')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/temp-files', 'temp files')
    assert.equal((await stateAt(store, snapshot.commit, 'file.turnrewind-01234567-89ab-cdef-0123-456789abcdef.tmp')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'nested/file.turnrewind-01234567-89ab-cdef-0123-456789abcdef.tmp')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'kept.txt')).kind, 'file')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses dangling symlink workspace paths during inspection and restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-dangling-link-test-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    try {
      await symlink(join(root, 'missing-target'), join(workspace, 'dangling'))
    }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES')
        return
      throw error
    }
    const store = createSnapshotStore(join(root, 'data'), workspace)
    await assert.rejects(() => currentState(workspace, 'dangling'), /TURNREWIND_SYMLINK_UNSUPPORTED/)
    await assert.rejects(
      () => restorePath(store, 'refs/turnrewind/missing', 'dangling'),
      /TURNREWIND_SYMLINK_UNSUPPORTED/,
    )
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
    await initGitWorkspace(workspace)
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
    await assert.rejects(() => currentState(workspace, 'linked/secret.txt'), /TURNREWIND_SYMLINK_UNSUPPORTED/)
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

it('keeps snapshot symlinks unrestorable and reported by undo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-symlink-undo-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'keep.txt'), 'before\n')
    await writeFile(join(workspace, 'original.txt'), 'original\n')
    try {
      await symlink('original.txt', join(workspace, 'link'))
    }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES')
        return
      throw error
    }
    const db = openLedger(join(root, 'ledger'))
    const store = createSnapshotStore(join(root, 'data'), workspace)
    await captureSnapshot(store, 'refs/turnrewind/sl-before', 'before')

    // The turn: replace the symlink with a regular file and edit keep.txt.
    await rm(join(workspace, 'link'))
    await writeFile(join(workspace, 'link'), 'now-a-file\n')
    await writeFile(join(workspace, 'keep.txt'), 'after\n')
    await captureSnapshot(store, 'refs/turnrewind/sl-after', 'after', 'refs/turnrewind/sl-before')
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey: resolve(workspace).toLowerCase(),
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/sl-before',
    })
    settleTurn(db, 'session:1', 'refs/turnrewind/sl-after')

    const runtime = {
      db,
      store,
      workspaceKey: resolve(workspace).toLowerCase(),
      parentRef: 'refs/turnrewind/sl-after',
      undoing: false,
    }
    const invocation = (rawInput = '') => ({
      rawInput,
      agent: { session: { id: 'session', header: { cwd: workspace } } },
    })

    // The preview flags the symlink entry as unsupported (P1-3).
    const preview = await applyUndo(runtime, new Map(), invocation())
    assert.equal(preview.kind, 'success')
    assert.match(preview.text, /link \[unsupported\]/u)
    assert.match(preview.text, /Unrestorable entries/u)

    // Confirm: keep.txt restores normally; the link is reported as not
    // restored and stays a regular file instead of receiving target text.
    const planId = /plan ([0-9a-f-]+)/u.exec(preview.text)?.[1]
    const confirmed = await applyUndo(runtime, new Map(), invocation(`--confirm ${planId}`))
    assert.equal(confirmed.kind, 'success')
    assert.match(confirmed.text, /Not restored \(1 file\(s\)\): link/u)
    assert.equal(await readFile(join(workspace, 'link'), 'utf8'), 'now-a-file\n')
    assert.equal(await readFile(join(workspace, 'keep.txt'), 'utf8'), 'before\n')
    db.close()
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})

it('refuses Windows junction directories like symlinks', async () => {
  if (process.platform !== 'win32')
    return
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-junction-test-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  try {
    await initGitWorkspace(workspace)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'outside')
    // Junctions need no elevation on Windows and are reparse points like
    // symlinks — traversal through them must be refused identically (P1-5).
    await symlink(outside, join(workspace, 'junction'), 'junction')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    await assert.rejects(() => currentState(workspace, 'junction/secret.txt'), /TURNREWIND_SYMLINK_UNSUPPORTED/)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/junction', 'junction')
    await assert.rejects(
      () => restorePath(store, snapshot.commit, 'junction/secret.txt'),
      /TURNREWIND_SYMLINK_UNSUPPORTED/,
    )
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})
