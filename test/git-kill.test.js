import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, gitExitIsClean, runGit } from '../src/host/service/git-snapshot'
import { initGitWorkspace } from './git-test-utils.js'

/**
 * External kills deliver either close(null, signal) or, on Windows, a
 * nonzero exit with no signal. Neither is a clean exit: partial stdout must
 * never be accepted as a complete Git result.
 */
it('gitExitIsClean only accepts a successful unsignalled exit', () => {
  assert.equal(gitExitIsClean(0, null), true)
  assert.equal(gitExitIsClean(0, undefined), true)
  assert.equal(gitExitIsClean(null, 'SIGKILL'), false)
  assert.equal(gitExitIsClean(null, 'SIGTERM'), false)
  assert.equal(gitExitIsClean(1, null), false)
  assert.equal(gitExitIsClean(null, null), false)
})

it('an abruptly terminated child is classified as unclean on every platform', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.kill(process.pid, "SIGKILL"), 50)'])
  const result = await new Promise((resolvePromise) => {
    child.on('close', (code, signal) => resolvePromise({ code, signal }))
  })
  assert.equal(gitExitIsClean(result.code, result.signal), false)
})

it('runGit keeps succeeding on the normal exit path after the kill guard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-kill-test-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'a.txt'), 'a\n')
    const store = createSnapshotStore(join(root, 'data'), workspace)
    const snapshot = await captureSnapshot(store, 'refs/turnrewind/kill-test', 'kill test')
    const output = await runGit(store.repoDir, store.workspaceDir, ['rev-parse', '--verify', 'refs/turnrewind/kill-test'])
    assert.ok(output.length > 0)
    assert.ok(snapshot.commit)
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})
