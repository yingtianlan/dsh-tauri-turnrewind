import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { it } from 'vitest'
import { createSnapshotStore, gitRef } from '../src/host/service/git-snapshot'
import { apply, turnSnapshotRef } from '../src/index'
import { initGitWorkspace } from './git-test-utils.js'

function createHarnessContext() {
  const events = new Map()
  const cleanups = []
  const routes = new Map()
  const commands = []
  const ctx = {
    commands: {
      register(command) {
        commands.push(command)
        return () => {}
      },
    },
    sessionProjections: {
      register() {
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    logger: {
      warn() {},
    },
    on(name, handler) {
      const listeners = events.get(name) ?? []
      listeners.push(handler)
      events.set(name, listeners)
      return () => {}
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function')
        cleanups.push(cleanup)
      return cleanup
    },
  }
  return { ctx, events, cleanups, routes, commands }
}

async function waitForRef(store, workspace, ref, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await gitRef(store.repoDir, workspace, ref)
    if (value)
      return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  return undefined
}

async function withHarness(test) {
  const root = await mkdtemp(join(tmpdir(), 'turnrewind-barrier-test-'))
  const workspace = join(root, 'workspace')
  const dshHome = join(root, 'dsh-home')
  await initGitWorkspace(workspace)
  await writeFile(join(workspace, 'before.txt'), 'before\n')

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  const harness = createHarnessContext()
  try {
    apply(harness.ctx)
    await test({ root, workspace, dshHome, harness })
  }
  finally {
    for (const dispose of harness.cleanups.reverse())
      await dispose()
    if (previousHome === undefined)
      delete process.env.DSH_HOME
    else
      process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
}

it('blocks the first model step until the claimed baseline completes', async () => {
  await withHarness(async ({ harness, workspace }) => {
    const agent = { session: { id: 'barrier-session', header: { cwd: workspace } } }
    const claimed = harness.events.get('agent/inbox/claimed')
    const preStep = harness.events.get('agent/pre-step')
    assert.equal(claimed?.length, 1)
    assert.equal(preStep?.length, 1)

    claimed[0]({ agent, turn: 1 })
    let continued = false
    const controller = new AbortController()
    const step = preStep[0]({ agent, turn: 1, signal: controller.signal }, async () => {
      continued = true
      return { kind: 'enter', messages: [] }
    })

    await Promise.resolve()
    assert.equal(continued, false)
    const decision = await step
    assert.equal(decision.kind, 'enter')
    assert.equal(continued, true)
  })
})

it('keeps consecutive claimed turns independent until both baselines are ready', async () => {
  await withHarness(async ({ harness, workspace, dshHome }) => {
    const agent = { session: { id: 'barrier-sequence', header: { cwd: workspace } } }
    const claimed = harness.events.get('agent/inbox/claimed')
    const preStep = harness.events.get('agent/pre-step')
    claimed[0]({ agent, turn: 1 })
    claimed[0]({ agent, turn: 2 })

    const controller = new AbortController()
    const firstStep = preStep[0]({ agent, turn: 1, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] }))
    const secondStep = preStep[0]({ agent, turn: 2, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] }))
    await Promise.all([firstStep, secondStep])

    const store = createSnapshotStore(dshHome, workspace)
    assert.ok(await waitForRef(store, workspace, turnSnapshotRef('barrier-sequence:1', 'before')))
    assert.ok(await waitForRef(store, workspace, turnSnapshotRef('barrier-sequence:2', 'before')))
  })
})

it('does not recreate a completed turn after a duplicate claim', async () => {
  await withHarness(async ({ harness, workspace, dshHome }) => {
    const agent = { session: { id: 'barrier-duplicate', header: { cwd: workspace } } }
    const claimed = harness.events.get('agent/inbox/claimed')
    const preStep = harness.events.get('agent/pre-step')
    const events = harness.events.get('session/event')
    const controller = new AbortController()

    claimed[0]({ agent, turn: 1 })
    await preStep[0]({ agent, turn: 1, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] }))
    events[0](agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300))

    const store = createSnapshotStore(dshHome, workspace)
    const beforeRef = turnSnapshotRef('barrier-duplicate:1', 'before')
    const afterRef = turnSnapshotRef('barrier-duplicate:1', 'after')
    const before = await waitForRef(store, workspace, beforeRef)
    const after = await waitForRef(store, workspace, afterRef)
    assert.ok(before)
    assert.ok(after)

    claimed[0]({ agent, turn: 1 })
    await Promise.resolve()
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    assert.equal(await gitRef(store.repoDir, workspace, beforeRef), before)
    assert.equal(await gitRef(store.repoDir, workspace, afterRef), after)
  })
})

it('does not snapshot overlapping turns from another session in the same workspace', async () => {
  await withHarness(async ({ harness, workspace, dshHome }) => {
    const claimed = harness.events.get('agent/inbox/claimed')
    const preStep = harness.events.get('agent/pre-step')
    const first = { session: { id: 'workspace-owner', header: { cwd: workspace } } }
    const second = { session: { id: 'workspace-other', header: { cwd: workspace } } }

    claimed[0]({ agent: first, turn: 1 })
    await preStep[0]({ agent: first, turn: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    claimed[0]({ agent: second, turn: 1 })
    await preStep[0]({ agent: second, turn: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))

    const store = createSnapshotStore(dshHome, workspace)
    assert.ok(await gitRef(store.repoDir, workspace, turnSnapshotRef('workspace-owner:1', 'before')))
    assert.equal(await gitRef(store.repoDir, workspace, turnSnapshotRef('workspace-other:1', 'before')), undefined)
  })
})

it('ignores a late claim after turn/end without leaving a live baseline', async () => {
  await withHarness(async ({ harness, workspace, dshHome }) => {
    const agent = { session: { id: 'barrier-late-claim', header: { cwd: workspace } } }
    const claimed = harness.events.get('agent/inbox/claimed')
    const preStep = harness.events.get('agent/pre-step')
    const events = harness.events.get('session/event')
    const controller = new AbortController()

    events[0](agent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    claimed[0]({ agent, turn: 2 })
    const decision = await preStep[0]({ agent, turn: 2, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.kind, 'enter')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    const store = createSnapshotStore(dshHome, workspace)
    assert.equal(await gitRef(store.repoDir, workspace, turnSnapshotRef('barrier-late-claim:2', 'before')), undefined)
  })
})
