import assert from 'node:assert/strict'
import { it } from 'vitest'
import { peekCardTranslator, peekSubmitLine, setCardTranslator, setSubmitLine } from '../src/client/components/command-view'
import * as client from '../src/client/index'

it('exposes the cordis plugin face and pure helpers', () => {
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'sessions', 'locale'])
  assert.equal(typeof client.parseUndoOutput, 'function')
  assert.equal(typeof client.resolvePlanStatus, 'function')
  assert.equal(typeof client.resolveOwnerSessionId, 'function')
})

it('resolvePlanStatus settles an expired plan as gone and stops polling', () => {
  // The host route answers 404 once the pending plan expired or was purged.
  const expired = client.resolvePlanStatus({ ok: false, status: 404 }, {})
  assert.deepEqual(expired, { status: 'gone', stop: true, resultText: null })
  // A host that ever reports gone explicitly settles the same way.
  const explicit = client.resolvePlanStatus({ ok: true, status: 200 }, { status: 'gone' })
  assert.deepEqual(explicit, { status: 'gone', stop: true, resultText: null })
})

it('resolvePlanStatus treats expired as a terminal archived state (not gone)', () => {
  // Expired plans stay in the ledger: the card keeps its archived view and
  // only execution is refused — it must NOT collapse to gone.
  const expired = client.resolvePlanStatus({ ok: true, status: 200 }, { status: 'expired' })
  assert.deepEqual(expired, { status: 'expired', stop: true, resultText: null })
})

it('resolvePlanStatus stops polling once the plan settles', () => {
  const applied = client.resolvePlanStatus({ ok: true, status: 200 }, { status: 'applied', resultText: 'Undid turn x' })
  assert.deepEqual(applied, { status: 'applied', stop: true, resultText: 'Undid turn x' })
  // Missing resultText stays null so the card can substitute its own label.
  const appliedBare = client.resolvePlanStatus({ ok: true, status: 200 }, { status: 'applied' })
  assert.deepEqual(appliedBare, { status: 'applied', stop: true, resultText: null })
  const cancelled = client.resolvePlanStatus({ ok: true, status: 200 }, { status: 'cancelled' })
  assert.deepEqual(cancelled, { status: 'cancelled', stop: true, resultText: null })
})

it('resolvePlanStatus keeps polling pending plans', () => {
  const pending = client.resolvePlanStatus({ ok: true, status: 200 }, { status: 'pending' })
  assert.deepEqual(pending, { status: 'pending', stop: false, resultText: null })
})

it('resolvePlanStatus keeps polling on non-404 failures without settling the plan', () => {
  for (const res of [{ ok: false, status: 500 }, { ok: false, status: 503 }, { ok: true, status: 200 }]) {
    const next = client.resolvePlanStatus(res, res.ok ? {} : { error: 'boom' })
    assert.deepEqual(next, { status: 'pending', stop: false, resultText: null })
  }
})

it('resolveOwnerSessionId prefers the session-scoped prop over the node', () => {
  assert.equal(client.resolveOwnerSessionId({ sessionId: 'session-a', node: { sessionId: 'session-b' } }), 'session-a')
  // Node field is the fallback for hosts that attach it to the command node.
  assert.equal(client.resolveOwnerSessionId({ node: { sessionId: 'session-b' } }), 'session-b')
})

it('resolveOwnerSessionId never guesses from missing or invalid ids', () => {
  assert.equal(client.resolveOwnerSessionId({}), null)
  assert.equal(client.resolveOwnerSessionId(undefined), null)
  assert.equal(client.resolveOwnerSessionId({ sessionId: '' }), null)
  assert.equal(client.resolveOwnerSessionId({ sessionId: 42 }), null)
  assert.equal(client.resolveOwnerSessionId({ sessionId: 'session-a', node: { sessionId: '' } }), 'session-a')
})

it('parseUndoOutput strips the unsupported flag from unrestorable entries', () => {
  const parsed = client.parseUndoOutput([
    'Undo preflight: turn s:1; 2 file(s) (modified 2, created 0, deleted 0); 0 conflict(s).',
    '  modified link [unsupported]',
    '  modified keep.txt',
  ].join('\n'))
  assert.deepEqual(
    parsed.files.map(file => [file.path, file.conflict]),
    [['link', false], ['keep.txt', false]],
  )
})

it('parseUndoOutput still extracts the pending plan id', () => {
  const parsed = client.parseUndoOutput([
    'Undo preflight: turn s:1; 1 file(s); 0 conflicts.',
    '  modified a.txt',
    '',
    'Undo will apply (turn output → restored state):',
    '--- a.txt',
    '  -v2',
    '  +v1',
    'plan 0f1e2d3c',
    'Send /undo --confirm 0f1e2d3c to apply, or /undo --cancel 0f1e2d3c to dismiss.',
  ].join('\n'))
  assert.equal(parsed.planId, '0f1e2d3c')
  assert.equal(parsed.summary, 'Undo preflight: turn s:1; 1 file(s); 0 conflicts.')
  assert.equal(parsed.files.length, 1)
})

it('parseUndoOutput keeps paths with spaces and plan flags out of the conflict fallback', () => {
  const parsed = client.parseUndoOutput([
    'Undo preflight: turn s:1; 3 file(s) (modified 2, created 1, deleted 0); 1 conflict(s).',
    '  modified my notes.txt',
    // Host formats change.padEnd(8) plus one separator: created has two spaces.
    '  created  reports/q3 summary.md',
    '  modified assets/logo.png  [conflict]',
    '  modified assets/hero.png  [too large]',
    '',
    'Oversized files (over the 64 MB restore limit) cannot be restored by this undo; they will be reported as not restored:',
    '  assets/hero.png',
    '',
    'Undo will apply (turn output → restored state):',
    '--- my notes.txt',
    '  -new',
    '  +old',
    'plan 0f1e2d3c',
    'Send /undo --confirm 0f1e2d3c to apply, or /undo --cancel 0f1e2d3c to dismiss.',
  ].join('\n'))

  assert.equal(parsed.files.length, 4)
  assert.deepEqual(
    parsed.files.map(file => [file.path, file.change, file.conflict]),
    [
      ['my notes.txt', 'modified', false],
      ['reports/q3 summary.md', 'created', false],
      ['assets/logo.png', 'modified', true],
      ['assets/hero.png', 'modified', false],
    ],
  )
  // The diff section attaches to the spaced path instead of creating a
  // duplicate "conflict" entry for it.
  const spaced = parsed.files.find(file => file.path === 'my notes.txt')
  assert.equal(spaced.diff.length, 2)
  assert.equal(spaced.additions, 1)
  assert.equal(spaced.deletions, 1)
})

it('channel setters are latest-owner-wins (HMR interleave guard)', () => {
  const channelA = async () => null
  const channelB = async () => null
  const translatorA = key => key
  const translatorB = key => key

  const releaseChannelA = setSubmitLine(channelA)
  const releaseTranslatorA = setCardTranslator(translatorA)
  // A newer install (an HMR successor) takes the channels over.
  const releaseChannelB = setSubmitLine(channelB)
  const releaseTranslatorB = setCardTranslator(translatorB)

  // The stale instance's cleanup must not clear the successor's channels.
  releaseChannelA()
  releaseTranslatorA()
  assert.equal(peekSubmitLine(), channelB)
  assert.equal(peekCardTranslator(), translatorB)

  // Only the latest owner's release actually clears.
  releaseChannelB()
  releaseTranslatorB()
  assert.equal(peekSubmitLine(), null)
  assert.equal(peekCardTranslator(), null)
})
