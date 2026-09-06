import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, stateAt } from '../src/host/service/git-snapshot'
import { gitOutput, initGitWorkspace } from './git-test-utils.js'

it('applies nested .gitignore patterns including negations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-ignore-nested-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, '.gitignore'), '*.log\n!keep.log\n')
    await mkdir(join(workspace, 'nested'))
    await writeFile(join(workspace, 'nested', '.gitignore'), 'inner-secret.txt\n')
    await writeFile(join(workspace, 'debug.log'), 'log')
    await writeFile(join(workspace, 'keep.log'), 'keep')
    await writeFile(join(workspace, 'nested', 'inner-secret.txt'), 'secret')
    await writeFile(join(workspace, 'nested', 'ok.txt'), 'ok')

    const store = createSnapshotStore(join(root, 'data'), workspace)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/ignore-nested', 'nested ignore')

    assert.equal((await stateAt(store, snapshot.commit, 'debug.log')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'keep.log')).kind, 'file')
    assert.equal((await stateAt(store, snapshot.commit, 'nested/inner-secret.txt')).kind, 'absent')
    assert.equal((await stateAt(store, snapshot.commit, 'nested/ok.txt')).kind, 'file')
    // The rule files themselves are ordinary tracked-able files.
    assert.equal((await stateAt(store, snapshot.commit, '.gitignore')).kind, 'file')
    assert.equal((await stateAt(store, snapshot.commit, 'nested/.gitignore')).kind, 'file')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('honors .git/info/exclude and re-syncs it when the source rules change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-ignore-exclude-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'excluded.txt'), 'excluded')
    await writeFile(join(workspace, 'kept.txt'), 'kept')
    const sourceExclude = join(workspace, '.git', 'info', 'exclude')
    await mkdir(dirname(sourceExclude), { recursive: true })
    await writeFile(sourceExclude, 'excluded.txt\n')

    const store = createSnapshotStore(join(root, 'data'), workspace)
    const first = await captureSnapshot(store, 'refs/turnrewind/ignore-exclude-1', 'first')
    assert.equal((await stateAt(store, first.commit, 'excluded.txt')).kind, 'absent')
    assert.equal((await stateAt(store, first.commit, 'kept.txt')).kind, 'file')

    // The source exclude file is mirrored into the private snapshot repo on
    // every capture, so relaxing the rule re-opens the file to snapshots.
    await writeFile(sourceExclude, '')
    const second = await captureSnapshot(store, 'refs/turnrewind/ignore-exclude-2', 'second', first.commit)
    assert.equal((await stateAt(store, second.commit, 'excluded.txt')).kind, 'file')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('honors the global excludes file like the source repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-ignore-global-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'globally-ignored.txt'), 'ignored')
    await writeFile(join(workspace, 'kept.txt'), 'kept')
    const globalExcludes = join(root, 'global-excludes')
    const globalConfig = join(root, 'global-gitconfig')
    await writeFile(globalExcludes, 'globally-ignored.txt\n')
    await writeFile(globalConfig, `[core]\n\texcludesFile = ${globalExcludes.replaceAll('\\', '/')}\n`)

    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    try {
      const store = createSnapshotStore(join(root, 'data'), workspace)
      const snapshot = await captureSnapshot(store, 'refs/turnrewind/ignore-global', 'global ignore')
      assert.equal((await stateAt(store, snapshot.commit, 'globally-ignored.txt')).kind, 'absent')
      assert.equal((await stateAt(store, snapshot.commit, 'kept.txt')).kind, 'file')
    }
    finally {
      if (previous === undefined)
        delete process.env.GIT_CONFIG_GLOBAL
      else
        process.env.GIT_CONFIG_GLOBAL = previous
    }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('normalizes text=auto files on capture and keeps -text files byte-exact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-ignore-attributes-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, '.gitattributes'), '*.txt text=auto\n*.bin -text\n')
    await writeFile(join(workspace, 'crlf.txt'), 'a\r\nb\r\n')
    await writeFile(join(workspace, 'lf.txt'), 'a\nb\n')
    await writeFile(join(workspace, 'crlf.bin'), 'a\r\nb\r\n')

    const store = createSnapshotStore(join(root, 'data'), workspace)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/attributes', 'attributes')

    // text=auto: the stored blob is LF-normalized, so the CRLF and LF twins
    // share one object. (stateAt digests normalize line endings too, so the
    // blob bytes are read directly to pin the object content.)
    const crlf = await stateAt(store, snapshot.commit, 'crlf.txt')
    const lf = await stateAt(store, snapshot.commit, 'lf.txt')
    assert.equal(crlf.kind, 'file')
    assert.equal(lf.kind, 'file')
    assert.equal(crlf.digest, lf.digest)
    assert.equal(await gitOutput(workspace, ['--git-dir', store.repoDir, 'cat-file', 'blob', `${snapshot.commit}:crlf.txt`]), 'a\nb\n')
    assert.equal(await gitOutput(workspace, ['--git-dir', store.repoDir, 'cat-file', 'blob', `${snapshot.commit}:lf.txt`]), 'a\nb\n')

    // -text: no conversion anywhere, the blob is byte-identical to the disk file.
    assert.equal(
      await gitOutput(workspace, ['--git-dir', store.repoDir, 'cat-file', 'blob', `${snapshot.commit}:crlf.bin`]),
      await readFile(join(workspace, 'crlf.bin'), 'utf8'),
    )
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
