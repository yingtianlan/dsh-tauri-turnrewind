import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse, resolve } from 'pathe'
import { it } from 'vitest'
import { createSnapshotStore, probeWorkspace } from '../src/host/service/git-snapshot'
import { isSystemSensitiveWorkspace } from '../src/host/service/guard'
import { initGitWorkspace } from './git-test-utils.js'

it('refuses the home directory, its ancestors, and drive roots', () => {
  assert.equal(isSystemSensitiveWorkspace(homedir()), true)
  assert.equal(isSystemSensitiveWorkspace(dirname(homedir())), true)
  assert.equal(isSystemSensitiveWorkspace(parse(homedir()).root), true)
  assert.equal(isSystemSensitiveWorkspace(parse(tmpdir()).root), true)
})

it('refuses plain directories that are not Git worktrees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-guard-plain-'))
  try {
    await writeFile(join(root, 'a.txt'), 'a')
    const probe = probeWorkspace(root)
    assert.equal(probe.ok, false)
    assert.match(probe.reason, /TURNREWIND_GIT_REQUIRED/)
    assert.throws(
      () => createSnapshotStore(join(root, 'data'), root),
      /TURNREWIND_GIT_REQUIRED/,
    )
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('accepts an ordinary Git worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-guard-git-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'a.txt'), 'a')
    const probe = probeWorkspace(workspace)
    assert.equal(probe.ok, true)
    assert.equal(probe.workspaceDir, resolve(workspace))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('canonicalizes a session cwd below the worktree root to the Git root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-guard-subdir-'))
  const workspace = join(root, 'workspace')
  const nested = join(workspace, 'packages', 'app')
  try {
    await initGitWorkspace(workspace)
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'a.txt'), 'a')

    // A session started from a subdirectory still belongs to the one Git
    // worktree: it must not become a second snapshot domain.
    const probe = probeWorkspace(nested)
    assert.equal(probe.ok, true)
    assert.equal(probe.workspaceDir, resolve(workspace))

    const nestedStore = createSnapshotStore(join(root, 'data'), nested)
    const rootStore = createSnapshotStore(join(root, 'data'), workspace)
    assert.equal(nestedStore.repoDir, rootStore.repoDir)
    assert.equal(nestedStore.workspaceDir, resolve(workspace))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reports the missing git executable instead of a misleading not-a-worktree reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-guard-nogit-'))
  try {
    await writeFile(join(root, 'plain.txt'), 'x')
    const savedPath = process.env.PATH
    // An empty PATH makes the synchronous spawn fail with ENOENT, exactly
    // like a machine without git on PATH.
    process.env.PATH = ''
    try {
      const probe = probeWorkspace(root)
      assert.equal(probe.ok, false)
      assert.match(probe.reason, /TURNREWIND_GIT_UNAVAILABLE/)
      assert.throws(
        () => createSnapshotStore(join(root, 'data'), root),
        /TURNREWIND_GIT_UNAVAILABLE/,
      )
    }
    finally {
      process.env.PATH = savedPath
    }
    // With git back on PATH the same directory reports the ordinary reason.
    const probe = probeWorkspace(root)
    assert.equal(probe.ok, false)
    assert.match(probe.reason, /TURNREWIND_GIT_REQUIRED/)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
