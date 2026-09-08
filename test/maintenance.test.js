import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { it } from 'vitest'
import { captureSnapshot, createSnapshotStore, workspaceHash, workspaceKey } from '../src/host/service/git-snapshot'
import { createOperation, createPendingPlan, getTurn, insertTurn, openLedger, queueRewindNotice, registerWorkspace, settleTurn } from '../src/host/service/ledger'
import { purgeWorkspace } from '../src/host/service/maintenance'
import { commitAll, gitOutput, initGitWorkspace } from './git-test-utils.js'

it('purges ledger rows and the snapshot repository for one workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-purge-test-'))
  const workspace = join(root, 'ws')
  const wsKey = workspaceKey(workspace)
  try {
    const db = openLedger(root)
    registerWorkspace(db, wsKey, workspace, join(root, 'snapshots', 'x.git'))
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey: wsKey,
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/turn-session-1-before',
    })
    settleTurn(db, 'session:1', 'refs/turnrewind/turn-session-1-after')
    createOperation(db, {
      operationId: 'op-1',
      kind: 'undo',
      targetTurnId: 'session:1',
      requestedAt: '2026-01-01T00:01:00.000Z',
    })
    queueRewindNotice(db, {
      noticeId: 'notice-1',
      sessionId: 'session',
      workspaceKey: wsKey,
      targetTurnId: 'session:1',
      paths: ['a.txt'],
      createdAt: '2026-01-01T00:01:00.000Z',
    })
    db.close()

    const repoDir = join(root, 'snapshots', `${workspaceHash(workspace)}.git`)
    await mkdir(join(repoDir, 'objects'), { recursive: true })
    await writeFile(join(repoDir, 'HEAD'), 'ref: refs/heads/main\n')

    const summary = purgeWorkspace(root, workspace)
    assert.equal(summary.repoExisted, true)
    assert.deepEqual(summary.ledger, { operations: 1, notices: 1, plans: 0, turns: 1, workspaces: 1 })
    assert.equal(existsSync(repoDir), false)

    const verify = openLedger(root)
    try {
      assert.equal(getTurn(verify, 'session:1'), undefined)
      assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM operations').get().count, 0)
      assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM rewind_notices').get().count, 0)
      assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM workspaces').get().count, 0)
    }
    finally {
      verify.close()
    }

    const repeat = purgeWorkspace(root, workspace)
    assert.equal(repeat.repoExisted, false)
    assert.deepEqual(repeat.ledger, { operations: 0, notices: 0, plans: 0, turns: 0, workspaces: 0 })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('purges only turnrewind data; the user repository and other workspaces stay intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-purge-safety-'))
  const dataRoot = join(root, 'dsh-home')
  const userProject = join(root, 'user-project')
  const otherProject = join(root, 'other-project')
  try {
    await initGitWorkspace(userProject)
    await initGitWorkspace(otherProject)
    await writeFile(join(userProject, 'tracked.txt'), 'v1\n')
    await commitAll(userProject, 'initial')
    const userHead = await gitOutput(userProject, ['rev-parse', 'HEAD'])
    const userStatus = await gitOutput(userProject, ['status', '--porcelain=v1', '-z'])

    const userStore = createSnapshotStore(dataRoot, userProject)
    await captureSnapshot(userStore, 'refs/turnrewind/purge-before', 'before')
    const otherStore = createSnapshotStore(dataRoot, otherProject)
    await captureSnapshot(otherStore, 'refs/turnrewind/other-before', 'other')

    const db = openLedger(dataRoot)
    registerWorkspace(db, workspaceKey(userProject), userProject, userStore.repoDir)
    registerWorkspace(db, workspaceKey(otherProject), otherProject, otherStore.repoDir)
    insertTurn(db, {
      turnId: 'user-session:1',
      sessionId: 'user-session',
      workspaceKey: workspaceKey(userProject),
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/purge-before',
    })
    db.close()

    const summary = purgeWorkspace(dataRoot, userProject)
    assert.equal(summary.repoExisted, true)
    assert.deepEqual(summary.ledger, { operations: 0, notices: 0, plans: 0, turns: 1, workspaces: 1 })
    assert.equal(existsSync(userStore.repoDir), false)

    // The user's repository is completely untouched: .git directory, HEAD,
    // porcelain status and worktree files all survive the purge.
    assert.equal(existsSync(join(userProject, '.git')), true)
    assert.equal(await gitOutput(userProject, ['rev-parse', 'HEAD']), userHead)
    assert.equal(await gitOutput(userProject, ['status', '--porcelain=v1', '-z']), userStatus)
    assert.equal(await readFile(join(userProject, 'tracked.txt'), 'utf8'), 'v1\n')

    // The purge removed exactly this workspace's data; the other workspace's
    // snapshot repository and ledger rows survive.
    assert.equal(existsSync(otherStore.repoDir), true)
    const verify = openLedger(dataRoot)
    try {
      assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM workspaces').get().count, 1)
      assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM turns').get().count, 0)
    }
    finally {
      verify.close()
    }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('purges data registered under a different spelling of the same workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-purge-spelling-'))
  const workspace = join(root, 'ws')
  try {
    await initGitWorkspace(workspace)
    const db = openLedger(root)
    registerWorkspace(db, workspaceKey(workspace), workspace, join(root, 'snapshots', 'ws.git'))
    insertTurn(db, {
      turnId: 'session:1',
      sessionId: 'session',
      workspaceKey: workspaceKey(workspace),
      startedAt: '2026-01-01T00:00:00.000Z',
      beforeRef: 'refs/turnrewind/turn-session-1-before',
    })
    settleTurn(db, 'session:1', 'refs/turnrewind/turn-session-1-after')
    db.close()

    const repoDir = join(root, 'snapshots', `${workspaceHash(workspace)}.git`)
    await mkdir(join(repoDir, 'objects'), { recursive: true })
    await writeFile(join(repoDir, 'HEAD'), 'ref: refs/heads/main\n')

    // Purge through a link alias of the same directory (junctions need no
    // elevation on Windows): canonical identity must land on the one
    // snapshot repo and ledger domain instead of forking a second empty one.
    const alias = join(root, 'ws-alias')
    await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const summary = purgeWorkspace(root, alias)
    assert.equal(summary.repoExisted, true)
    assert.deepEqual(summary.ledger, { operations: 0, notices: 0, plans: 0, turns: 1, workspaces: 1 })
    assert.equal(existsSync(repoDir), false)
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})

it('purges pending plans bound to the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-purge-plans-'))
  const workspace = join(root, 'ws')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, 'a.txt'), 'a')
    const db = openLedger(root)
    createPendingPlan(db, {
      sessionId: 'session',
      workspaceKey: workspaceKey(workspace),
      turnId: 'session:1',
      paths: ['a.txt'],
      beforeRef: 'refs/turnrewind/turn-1-before',
      afterRef: 'refs/turnrewind/turn-1-after',
    })
    createPendingPlan(db, {
      sessionId: 'session',
      workspaceKey: workspaceKey(join(root, 'other')),
      turnId: 'session:2',
      paths: ['b.txt'],
      beforeRef: 'refs/turnrewind/turn-2-before',
      afterRef: 'refs/turnrewind/turn-2-after',
    })
    db.close()

    const summary = purgeWorkspace(root, workspace)
    assert.deepEqual(summary.ledger, { operations: 0, notices: 0, plans: 1, turns: 0, workspaces: 0 })

    const verify = openLedger(root)
    try {
      const remaining = verify.prepare('SELECT workspace_key FROM pending_plans').all().map(row => row.workspace_key)
      assert.deepEqual(remaining, [workspaceKey(join(root, 'other'))])
    }
    finally {
      verify.close()
    }
  }
  finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})
