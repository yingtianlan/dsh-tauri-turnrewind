import assert from 'node:assert/strict'
import { it } from 'vitest'
import { planPathsDigest } from '../src/host/service/ledger'
import { aggregatePathPlan, classifyUndo, collectDescendantTurns, planDrift } from '../src/host/service/planner'

it('collects a selected turn subtree in leaf-first order', () => {
  const root = { turn_id: 'p' }
  const children = new Map([
    ['p', [{ turn_id: 'a' }, { turn_id: 'c' }]],
    ['a', [{ turn_id: 'b' }]],
    ['c', []],
    ['b', []],
  ])
  assert.deepEqual(collectDescendantTurns(root, children).map(turn => turn.turn_id), ['b', 'a', 'c', 'p'])
})

it('aggregates paths without duplicating overlapping files', () => {
  const turns = [{ turn_id: 'b' }, { turn_id: 'a' }]
  const paths = new Map([
    ['b', ['src/a.ts', 'src/b.ts']],
    ['a', ['src/a.ts']],
  ])
  assert.deepEqual(aggregatePathPlan(turns, turn => paths.get(turn.turn_id)).map(entry => entry.path), ['src/a.ts', 'src/b.ts'])
})

it('classifies stale content as a conflict', () => {
  assert.equal(classifyUndo({ kind: 'file', digest: 'same' }, { kind: 'file', digest: 'same' }), 'safe')
  assert.equal(classifyUndo({ kind: 'file', digest: 'new' }, { kind: 'file', digest: 'old' }), 'conflict')
  assert.equal(classifyUndo({ kind: 'absent', digest: null }, { kind: 'file', digest: 'old' }), 'conflict')
})

it('detects pending plan drift against the confirmed turn and diff', () => {
  const target = { turn_id: 's:1', before_ref: 'refs/turnrewind/b', after_ref: 'refs/turnrewind/a' }
  const binding = {
    before_ref: 'refs/turnrewind/b',
    after_ref: 'refs/turnrewind/a',
    paths_digest: planPathsDigest(['a.txt', 'b.txt']),
  }
  // Same refs and the same path set in any order: no drift.
  assert.equal(planDrift(binding, target, ['b.txt', 'a.txt']), undefined)
  // A different change set is drift even when the refs still match.
  assert.match(planDrift(binding, target, ['a.txt']), /change set no longer matches/u)
  // Rewritten turn refs are drift regardless of the recomputed paths.
  assert.match(
    planDrift(binding, { ...target, after_ref: 'refs/turnrewind/a2' }, ['a.txt', 'b.txt']),
    /snapshots no longer match/u,
  )
  // Legacy plans (NULL binding columns) cannot be verified: they are rejected
  // (forced re-preview) instead of being trusted without checks.
  assert.match(
    planDrift({ before_ref: null, after_ref: null, paths_digest: null }, target, []),
    /predates preview binding/u,
  )
})

it('produces a stable order-independent paths digest', () => {
  assert.equal(planPathsDigest(['b.txt', 'a.txt']), planPathsDigest(['a.txt', 'b.txt']))
  assert.notEqual(planPathsDigest(['a.txt']), planPathsDigest(['a.txt', 'b.txt']))
})
