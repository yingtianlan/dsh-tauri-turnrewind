import assert from 'node:assert/strict'
import { it } from 'vitest'
import { createHeadsUpTracker, resolveSessionsService } from '../src/client/utils/heads-up'

function notice(id, reason = 'r') {
  return { id, reason }
}

it('seeds the first observation of a session without popping', () => {
  const tracker = createHeadsUpTracker()
  assert.deepEqual(tracker.observe('s1', [notice('a'), notice('b')]), [])
  // Seeded ids never re-pop for the same session.
  assert.deepEqual(tracker.observe('s1', [notice('a'), notice('b')]), [])
})

it('pops exactly once for notices arriving while the page is alive', () => {
  const tracker = createHeadsUpTracker()
  tracker.observe('s1', [notice('a')])
  assert.deepEqual(tracker.observe('s1', [notice('b')]), [notice('b')])
  // The same notice does not pop twice.
  assert.deepEqual(tracker.observe('s1', [notice('b')]), [])
})

it('re-seeds when the session switches and treats its history as archived', () => {
  const tracker = createHeadsUpTracker()
  tracker.observe('s1', [notice('a')])
  // Switching to s2: its existing notice is history, not a fresh alert.
  assert.deepEqual(tracker.observe('s2', [notice('b')]), [])
  // Back to s1: its known notice stays archived.
  assert.deepEqual(tracker.observe('s1', [notice('a')]), [])
  // A genuinely new notice in s1 still pops.
  assert.deepEqual(tracker.observe('s1', [notice('c')]), [notice('c')])
})

it('resolveSessionsService accepts only services with the full list shape', () => {
  const good = { list: { getSnapshot: () => ({}), subscribe: () => () => {} } }
  assert.equal(resolveSessionsService([undefined, null, {}, good]), good)
  assert.equal(resolveSessionsService([{ list: { getSnapshot: () => ({}) } }]), undefined)
  assert.equal(resolveSessionsService([]), undefined)
})
