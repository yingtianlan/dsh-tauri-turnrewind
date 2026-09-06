import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, it } from 'vitest'
import { captureSnapshot, createSnapshotStore, workspaceKey } from '../src/host/service/git-snapshot'
import { insertTurn, openLedger, settleTurn } from '../src/host/service/ledger'
import { enforceRetention } from '../src/host/service/retention'
import { gitOutput, initGitWorkspace } from './git-test-utils.js'

const cleanups = []

afterEach(async () => {
  for (const dispose of cleanups.reverse())
    await dispose()
  cleanups.length = 0
  for (const name of ['TURNREWIND_RETAIN_TURNS', 'TURNREWIND_MAX_SNAPSHOT_MB'])
    delete process.env[name]
})

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-retention-'))
  cleanups.push(async () => rm(root, { recursive: true, force: true }))
  return root
}

async function makeWorkspace(root, name) {
  const workspace = join(root, name)
  await initGitWorkspace(workspace)
  return workspace
}

function seedTurns(db, workspaceKey, count, offset = 0) {
  for (let index = 0; index < count; index++) {
    const turnId = `session:${offset + index + 1}`
    const startedAt = new Date(Date.UTC(2026, 0, 1, 0, offset + index)).toISOString()
    insertTurn(db, { turnId, sessionId: 'session', workspaceKey, startedAt, beforeRef: `refs/turnrewind/${turnId}-before` })
    settleTurn(db, turnId, `refs/turnrewind/${turnId}-after`)
  }
}

it('expires turns beyond the retention count, keeping the most recent', async () => {
  const root = await makeRoot()
  const workspace = await makeWorkspace(root, 'ws')
  const db = openLedger(join(root, 'ledger'))
  const store = createSnapshotStore(join(root, 'data'), workspace)
  seedTurns(db, workspaceKey(workspace), 5)
  process.env.TURNREWIND_RETAIN_TURNS = '3'

  const result = enforceRetention(db, store, { maxSnapshotMb: 1024 })
  assert.equal(result.expiredByCount, 2)
  assert.equal(result.rebuilt, false)

  // The 3 most recent reversible turns survive; the 2 oldest are archived.
  const reversible = db.prepare(`
    SELECT turn_id FROM turns WHERE reversible = 1 ORDER BY started_at
  `).all().map(row => row.turn_id)
  assert.deepEqual(reversible, ['session:3', 'session:4', 'session:5'])
  const archived = db.prepare(`
    SELECT error FROM turns WHERE reversible = 0 AND turn_id LIKE 'session:%'
  `).all().map(row => row.error)
  assert.ok(archived.every(error => /retention:/u.test(error)))
  db.close()
})

it('rebuilds the snapshot repository when it exceeds the size cap', async () => {
  const root = await makeRoot()
  const workspace = await makeWorkspace(root, 'ws')
  const db = openLedger(join(root, 'ledger'))
  const store = createSnapshotStore(join(root, 'data'), workspace)
  seedTurns(db, workspaceKey(workspace), 2)
  // Simulate a bloated snapshot repo (the size walk reads the real directory).
  await mkdir(join(store.repoDir, 'objects'), { recursive: true })
  await writeFile(join(store.repoDir, 'objects', 'blob'), Buffer.alloc(2 * 1024 * 1024, 1))
  // A leftover quarantine from a crashed earlier rebuild must be swept first.
  await mkdir(`${store.repoDir}.retention-quarantine`, { recursive: true })
  await writeFile(join(`${store.repoDir}.retention-quarantine`, 'junk'), Buffer.alloc(1024, 1))
  process.env.TURNREWIND_MAX_SNAPSHOT_MB = '1'

  const result = enforceRetention(db, store, { retainTurns: 50 })
  assert.equal(result.rebuilt, true)
  assert.equal(result.expiredByRebuild, 2)
  assert.equal(result.repoSizeMb >= 1, true)

  // The repo directory is gone (next capture self-heals a fresh baseline)
  // and every reversible turn of the workspace is archived with the reason.
  const exists = await db.prepare(`
    SELECT COUNT(*) AS count FROM turns
    WHERE workspace_key = ? AND reversible = 1
  `).get(workspaceKey(workspace))
  assert.equal(exists.count, 0)
  const errors = db.prepare(`
    SELECT error FROM turns WHERE workspace_key = ? AND reversible = 0
  `).all().map(row => row.error)
  assert.ok(errors.every(error => /snapshot repository rebuilt/u.test(error)))
  // Two-phase rebuild: no half-deleted live directory or quarantine leftover.
  assert.equal(existsSync(store.repoDir), false)
  assert.equal(existsSync(`${store.repoDir}.retention-quarantine`), false)
  db.close()
})

it('keeps everything when under both limits', async () => {
  const root = await makeRoot()
  const workspace = await makeWorkspace(root, 'ws')
  const db = openLedger(join(root, 'ledger'))
  const store = createSnapshotStore(join(root, 'data'), workspace)
  seedTurns(db, workspaceKey(workspace), 3)
  process.env.TURNREWIND_RETAIN_TURNS = '10'
  process.env.TURNREWIND_MAX_SNAPSHOT_MB = '1024'

  const result = enforceRetention(db, store)
  assert.equal(result.expiredByCount, 0)
  assert.equal(result.rebuilt, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM turns WHERE reversible = 1').get().count, 3)
  db.close()
})

it('prunes unreachable loose objects before measuring the size cap', async () => {
  const root = await makeRoot()
  const workspace = await makeWorkspace(root, 'ws')
  const db = openLedger(join(root, 'ledger'))
  const store = createSnapshotStore(join(root, 'data'), workspace)
  // A real capture first: the private repository must exist (and the reachable
  // objects it holds must survive the prune).
  const seed = await captureSnapshot(store, 'refs/turnrewind/prune-seed', 'seed')
  // Simulate the disk-content blobs diffAgainstDisk hashes into the repo
  // during conflict previews: written via hash-object, referenced by nothing.
  const stray = join(workspace, 'stray.txt')
  await writeFile(stray, 'unreachable preview content\n')
  const oid = (await gitOutput(workspace, ['--git-dir', store.repoDir, 'hash-object', '-w', 'stray.txt'])).trim()
  const loosePath = join(store.repoDir, 'objects', oid.slice(0, 2), oid.slice(2))
  assert.equal(existsSync(loosePath), true)

  const result = enforceRetention(db, store)
  assert.equal(result.rebuilt, false)
  assert.equal(existsSync(loosePath), false, 'unreachable loose object must be pruned')
  // The reachable snapshot chain is untouched by the prune.
  assert.equal((await gitOutput(workspace, ['--git-dir', store.repoDir, 'cat-file', '-t', seed.commit])).trim(), 'commit')
  db.close()
})
