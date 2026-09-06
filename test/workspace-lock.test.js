import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'pathe'
import { afterEach, it } from 'vitest'
import { workspaceHash } from '../src/host/service/git-snapshot'
import { acquireWorkspaceLock, acquireWorkspaceLockSync, withWorkspaceLock, WorkspaceLockBusyError } from '../src/host/service/workspace-lock'

const cleanup = []

afterEach(async () => {
  for (const dispose of cleanup.reverse())
    await dispose()
  cleanup.length = 0
})

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-lock-test-'))
  cleanup.push(async () => rm(root, { recursive: true, force: true }))
  return root
}

function lockPath(root, workspaceDir) {
  // Mirror the private layout: locks/<workspace-hash>.lock (same hash as the module).
  return join(root, 'locks', `${workspaceHash(workspaceDir)}.lock`)
}

let cachedDeadPid

/** A pid that is guaranteed to be gone: the child exited before we return. */
function deadPid() {
  if (cachedDeadPid === undefined) {
    const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    cachedDeadPid = result.pid ?? -1
  }
  return cachedDeadPid
}

async function writeLock(root, workspaceDir, { pid, ageMs = 0 }) {
  const path = lockPath(root, workspaceDir)
  await mkdir(dirname(path), { recursive: true })
  const acquiredAt = new Date(Date.now() - ageMs).toISOString()
  await writeFile(path, JSON.stringify({ pid, token: 'external', acquiredAt, host: 'test' }), 'utf8')
}

it('releases the lock on release and allows reacquire', async () => {
  const root = await makeRoot()
  const ws = join(root, 'workspace')
  const handle = await acquireWorkspaceLock(root, ws)
  assert.ok(existsSync(lockPath(root, ws)))
  handle.release()
  assert.equal(existsSync(lockPath(root, ws)), false)
  const second = await acquireWorkspaceLock(root, ws)
  second.release()
})

it('refuses a second holder while the lock is alive', async () => {
  const root = await makeRoot()
  const ws = join(root, 'workspace')
  const handle = await acquireWorkspaceLock(root, ws)
  try {
    await assert.rejects(
      () => acquireWorkspaceLock(root, ws),
      error => error instanceof WorkspaceLockBusyError && /TURNREWIND_LOCK_BUSY/u.test(error.message),
    )
    // The sync variant fails the same way for offline tools.
    assert.throws(() => acquireWorkspaceLockSync(root, ws), WorkspaceLockBusyError)
  }
  finally {
    handle.release()
  }
})

it('takes over a lock left by a dead process', async () => {
  const root = await makeRoot()
  const ws = join(root, 'workspace')
  await writeLock(root, ws, { pid: deadPid() })
  const handle = await acquireWorkspaceLock(root, ws)
  // Takeover rewrites the file with the new owner's token.
  const content = JSON.parse(readFileSync(lockPath(root, ws), 'utf8'))
  assert.notEqual(content.token, 'external')
  handle.release()
  assert.equal(existsSync(lockPath(root, ws)), false)
})

it('takes over a lock whose TTL expired even if the pid is alive', async () => {
  const root = await makeRoot()
  const ws = join(root, 'workspace')
  // Our own pid is alive, but the acquisition is 31 minutes old.
  await writeLock(root, ws, { pid: process.pid, ageMs: 31 * 60 * 1000 })
  const handle = await acquireWorkspaceLock(root, ws)
  handle.release()
})

it('release never removes a lock taken over by another owner', async () => {
  const root = await makeRoot()
  const ws = join(root, 'workspace')
  const handle = await acquireWorkspaceLock(root, ws)
  // Simulate a takeover: the file now belongs to someone else.
  await writeLock(root, ws, { pid: process.pid })
  handle.release()
  // The foreign lock survives; a new acquirer still sees it as busy.
  await assert.rejects(() => acquireWorkspaceLock(root, ws), WorkspaceLockBusyError)
})

it('withWorkspaceLock runs the work and always releases', async () => {
  const root = await makeRoot()
  const ws = join(root, 'workspace')
  const result = await withWorkspaceLock(root, ws, async () => 'done')
  assert.equal(result, 'done')
  assert.equal(existsSync(lockPath(root, ws)), false)
  await assert.rejects(
    () => withWorkspaceLock(root, ws, async () => {
      throw new Error('boom')
    }),
    /boom/u,
  )
  assert.equal(existsSync(lockPath(root, ws)), false, 'release must happen even when the work throws')
})
