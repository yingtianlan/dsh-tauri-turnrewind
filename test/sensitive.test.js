import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { it } from 'vitest'
import { claimRewindNotices, hasSensitiveNotice, openLedger, queueSensitiveNotice } from '../src/host/service/ledger'
import { findUnignoredSensitiveFiles } from '../src/host/service/sensitive'
import { createNoticeMessage } from '../src/host/service/undo'
import { initGitWorkspace, runGit } from './git-test-utils.js'

it('finds unignored sensitive files and filters gitignored ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-sensitive-'))
  const workspace = join(root, 'workspace')
  try {
    await initGitWorkspace(workspace)
    await writeFile(join(workspace, '.gitignore'), '/.env\n/creds/**\n')
    await writeFile(join(workspace, '.env'), 'SECRET=1\n')
    await writeFile(join(workspace, 'server.pem'), '-----BEGIN\n')
    await mkdir(join(workspace, 'sub'))
    await writeFile(join(workspace, 'sub', 'token.key'), 'k\n')
    await mkdir(join(workspace, 'creds'), { recursive: true })
    await writeFile(join(workspace, 'creds', 'id_rsa'), 'k\n')
    await runGit(workspace, ['add', '.gitignore'])

    const found = await findUnignoredSensitiveFiles(workspace)
    assert.deepEqual(found, ['server.pem', 'sub/token.key'])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('queues one sensitive notice per session and workspace and builds its message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-sensitive-notice-'))
  const db = openLedger(root)
  try {
    assert.equal(hasSensitiveNotice(db, 'session', 'ws'), false)
    assert.equal(queueSensitiveNotice(db, 'session', 'ws', ['.env', 'sub/token.key']), true)
    // Repeat (another process racing, another turn) is a no-op.
    assert.equal(queueSensitiveNotice(db, 'session', 'ws', ['.env']), false)
    assert.equal(hasSensitiveNotice(db, 'session', 'ws'), true)

    const notices = claimRewindNotices(db, 'session', 'ws')
    assert.equal(notices.length, 1)
    assert.equal(notices[0].kind, 'sensitive-files')
    assert.deepEqual(notices[0].paths, ['.env', 'sub/token.key'])

    const message = createNoticeMessage(notices[0])
    assert.match(message.source.form, /rewind-privacy-notice/u)
    assert.match(message.content[0].text, /\[Turn rewind privacy notice\]/u)
    assert.match(message.content[0].text, /- \.env/u)
    // Already consumed: no further notices.
    assert.deepEqual(claimRewindNotices(db, 'session', 'ws'), [])
  }
  finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
