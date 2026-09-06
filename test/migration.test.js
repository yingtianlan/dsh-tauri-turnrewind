import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'pathe'
import { it } from 'vitest'
import { claimRewindNotices, createPendingPlan, getPendingPlanStatus, hasNeedsRecoveryWorkspace, openLedger } from '../src/host/service/ledger'

/**
 * 迁移重放：用 git 历史上最早的账本 schema（pending_plans 无
 * status/result_text/before_ref/after_ref/paths_digest，rewind_notices 无
 * turns_json/kind/reason，operations 无 after_ref）构造一个"老版本遗物"，
 * openLedger 必须 idempotent 地补列并让遗留数据继续工作。
 */
const LEGACY_SCHEMA = `
  CREATE TABLE workspaces (
    workspace_key TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    snapshot_repo TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_turn_id TEXT,
    workspace_key TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    settled_at TEXT,
    before_ref TEXT,
    after_ref TEXT,
    reversible INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_turn_id TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    settled_at TEXT,
    outcome TEXT,
    before_ref TEXT,
    error TEXT
  );
  CREATE TABLE rewind_notices (
    notice_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    target_turn_id TEXT,
    paths_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    claimed_at TEXT
  );
  CREATE TABLE pending_plans (
    plan_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    paths_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX turns_session_idx ON turns(session_id, started_at);
`

/** Windows may hold freshly closed sqlite sidecar files briefly: retry, then give up quietly. */
async function cleanupDir(root) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    }
    catch (error) {
      if (attempt >= 4 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code))
        return
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
}

it('upgrades a legacy ledger in place and keeps every row working', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-migration-'))
  try {
    // Build the pre-migration database with representative rows.
    const legacy = new DatabaseSync(join(root, 'ledger.sqlite'))
    legacy.exec(LEGACY_SCHEMA)
    legacy.exec(`
      INSERT INTO workspaces VALUES ('c:\\legacy', 'C:\\Legacy', 'repo.git', '2026-01-01T00:00:00.000Z');
      INSERT INTO turns VALUES ('session:1', 'session', NULL, 'c:\\legacy', 'settled', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'refs/turnrewind/turn-1-before', 'refs/turnrewind/turn-1-after', 1, NULL);
      INSERT INTO operations VALUES ('op-legacy', 'undo', 'session:1', '2026-01-01T00:02:00.000Z', NULL, 'applying', 'refs/turnrewind/op-before', NULL);
      INSERT INTO rewind_notices VALUES ('notice-legacy', 'session', 'c:\\legacy', 'session:1', '[]', 'pending', '2026-01-01T00:03:00.000Z', NULL);
      INSERT INTO pending_plans VALUES ('plan-legacy', 'session', 'c:\\legacy', 'session:1', '["a.txt"]', '2026-01-01T00:04:00.000Z', '2026-01-01T00:09:00.000Z');
    `)
    legacy.close()

    // Reopening runs the idempotent migrations plus the reopen sweeps.
    const db = openLedger(root)

    // The legacy applying operation is fenced exactly like a modern crash,
    // and the legacy turn is still there for the recovery panel to describe.
    assert.equal(hasNeedsRecoveryWorkspace(db, 'c:\\legacy'), true)

    // The legacy plan row survives; its past TTL is archived as expired and
    // the status poll answers from the migrated columns.
    const status = getPendingPlanStatus(db, 'plan-legacy', 'session')
    assert.equal(status?.status, 'expired')

    // A brand-new plan (with preview binding columns) writes fine.
    const freshPlan = createPendingPlan(db, {
      sessionId: 'session',
      workspaceKey: 'c:\\legacy',
      turnId: 'session:1',
      paths: ['a.txt'],
      beforeRef: 'refs/turnrewind/turn-1-before',
      afterRef: 'refs/turnrewind/turn-1-after',
    })
    assert.notEqual(freshPlan, undefined)

    // The legacy notice claims cleanly: turns_json was added with an empty
    // default and parses, paths come through verbatim.
    const notices = claimRewindNotices(db, 'session', 'c:\\legacy')
    assert.equal(notices.length, 1)
    assert.equal(notices[0].notice_id, 'notice-legacy')
    assert.deepEqual(notices[0].turns, [])
    assert.deepEqual(notices[0].paths, [])
    db.close()
  }
  finally {
    await cleanupDir(root)
  }
})
