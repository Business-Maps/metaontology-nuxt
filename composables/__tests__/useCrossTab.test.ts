/**
 * Tests for `useCrossTab`  - the BroadcastChannel cross-tab coordinator.
 *
 * What this file covers:
 *   - delivery: a sibling tab's commit reaches this tab's host
 *   - no echo: this tab's own broadcasts do not trigger its own host
 *   - dedup: redelivered commits (same id) are dropped
 *   - sync push filter: commits received from a sibling tab are excluded
 *     from `useSyncEngine.push()`
 *   - activate/deactivate lifecycle and idempotency
 *   - host failure isolation (host throws → cross-tab keeps working)
 *
 * Test fixture model
 *   The composable uses a per-tab `tabId` generated at module load. In a single
 *   test process there is exactly one `tabId`. We simulate a "sibling tab" by
 *   opening a second `BroadcastChannel` directly and posting envelopes with a
 *   different `fromTabId`. The composable's receive handler treats them as
 *   genuine cross-tab messages.
 *
 *   BroadcastChannel deliveries are scheduled on the macrotask queue, so each
 *   test that expects a message awaits one tick (`await tick()`) before
 *   asserting.
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useCrossTab, resetCrossTabSingleton, type CrossTabHost } from '../useCrossTab'
import { useCommitLog, resetCommitLogSingleton } from '../useCommitLog'
import { useSyncEngine, resetSyncEngineSingleton, type SyncHost } from '../useSyncEngine'
import type { SyncAdapter, PushResult, PullResult } from '../syncTypes'
import { createEmptyRootContext } from '@businessmaps/metaontology/engine/apply'
import type { Commit } from '@businessmaps/metaontology/types/commits'
import type { RootContext } from '@businessmaps/metaontology/types/context'
import type { Command } from '@businessmaps/metaontology/types/commands'
import type { MergeResult } from '@businessmaps/metaontology/types/branch'
import { resetIdb } from '../../__tests__/helpers/resetIdb'

// ── Helpers ────────────────────────────────────────────────────────────────
//
// The commit log treats layouts as opaque `unknown` at the ontology
// boundary, so tests don't need to import the concrete BM CanvasLayout
// type  - a local structural stand-in is enough.
type TestLayout = {
  modelId: string
  positions: Record<string, { x: number; y: number }>
  handles: Record<string, { sourceHandle?: string; targetHandle?: string }>
  sizes: Record<string, { width: number; height: number }>
  zIndices: Record<string, number>
}

function emptyLayout(modelId: string): TestLayout {
  return { modelId, positions: {}, handles: {}, sizes: {}, zIndices: {} }
}

/**
 * Flush BroadcastChannel deliveries.
 *
 * Node's BroadcastChannel implementation queues sends through libuv and
 * doesn't always deliver on a single `setTimeout(0)` macrotask  - sometimes
 * a single tick lands the message, sometimes two ticks are required, and
 * a closed channel mid-flight drops the message entirely. We wait several
 * macrotasks (in 1ms increments) so deliveries reliably land before
 * assertions run. The total wait stays well under 10ms even when all
 * iterations are needed, so test runtime is unaffected.
 */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/** Build a synthetic Commit at the named sequence with a given mapId. */
function makeCommit(opts: {
  mapId: string
  sequence: number
  id?: string
  deviceId?: string
  command?: Command
}): Commit {
  const command: Command = opts.command ?? {
    type: 'context:add',
    payload: { name: `ctx-${opts.sequence}`, parentUri: opts.mapId },
  }
  return {
    id: opts.id ?? `commit-${opts.sequence}-${Math.random().toString(36).slice(2, 8)}`,
    mapId: opts.mapId,
    sequence: opts.sequence,
    command,
    inverse: { type: 'context:remove', payload: { contextUri: 'placeholder' } } as any,
    timestamp: new Date().toISOString(),
    deviceId: opts.deviceId ?? 'device-test',
    branchId: 'main',
    parentId: null,
  }
}

/** Build a host that captures `applyRemoteCommit` calls. */
function makeRecordingHost(): CrossTabHost & { received: Commit[]; throwOnce: boolean } {
  const received: Commit[] = []
  return {
    received,
    throwOnce: false,
    applyRemoteCommit(commit: Commit) {
      if (this.throwOnce) {
        this.throwOnce = false
        throw new Error('host failure')
      }
      received.push(commit)
    },
  } as any
}

async function bootstrapCommitLog(name = 'CrossTab Test'): Promise<{
  root: RootContext
  layout: TestLayout
}> {
  const root = createEmptyRootContext(name)
  const layout = emptyLayout(root.uri)
  const log = useCommitLog()
  log.reset()
  log.setDeviceId('device-test')
  await log.initFromSnapshot(root.uri, root, layout)
  return { root, layout }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

beforeEach(async () => {
  await resetIdb()
  resetCommitLogSingleton()
  resetSyncEngineSingleton()
  resetCrossTabSingleton()
})

afterEach(() => {
  resetCrossTabSingleton()
  resetSyncEngineSingleton()
})

// ── Activation ─────────────────────────────────────────────────────────────

describe('useCrossTab  - activation', () => {
  it('starts inactive', () => {
    const tab = useCrossTab()
    expect(tab.enabled.value).toBe(false)
    expect(tab.activeMapId.value).toBeNull()
  })

  it('activate sets enabled and mapId', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    const host = makeRecordingHost()

    tab.activate('map-1', host)

    expect(tab.enabled.value).toBe(true)
    expect(tab.activeMapId.value).toBe('map-1')
  })

  it('deactivate clears enabled and mapId', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    tab.activate('map-1', makeRecordingHost())
    tab.deactivate()

    expect(tab.enabled.value).toBe(false)
    expect(tab.activeMapId.value).toBeNull()
  })

  it('activate is idempotent for the same mapId', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    const host = makeRecordingHost()
    tab.activate('map-1', host)
    tab.activate('map-1', host)
    expect(tab.enabled.value).toBe(true)
    expect(tab.activeMapId.value).toBe('map-1')
  })

  it('activate for a different mapId deactivates the previous channel', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    tab.activate('map-1', makeRecordingHost())
    tab.activate('map-2', makeRecordingHost())
    expect(tab.activeMapId.value).toBe('map-2')
  })

  it('exposes a stable per-tab id', () => {
    const tab = useCrossTab()
    const id1 = tab.getTabId()
    const id2 = tab.getTabId()
    expect(id1).toBe(id2)
    expect(typeof id1).toBe('string')
    expect(id1.length).toBeGreaterThan(0)
  })
})

// ── Delivery ───────────────────────────────────────────────────────────────

describe('useCrossTab  - delivery from a sibling tab', () => {
  it('forwards a sibling tab commit to the host', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    const host = makeRecordingHost()
    tab.activate('map-deliver', host)

    // Simulate a sibling tab posting on the same channel. Close the sibling
    // AFTER awaiting the tick: Node's BroadcastChannel may drop pending sends
    // when close() runs before delivery (browsers queue messages first, so
    // either order works there  - Node is stricter).
    const sibling = new BroadcastChannel('bm-crosstab-map-deliver')
    const commit = makeCommit({ mapId: 'map-deliver', sequence: 1 })
    sibling.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit })

    await tick()
    sibling.close()

    expect(host.received).toHaveLength(1)
    expect(host.received[0]!.id).toBe(commit.id)
  })

  it('forwards multiple commits in delivery order from a single sender', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    const host = makeRecordingHost()
    tab.activate('map-order', host)

    const sibling = new BroadcastChannel('bm-crosstab-map-order')
    const c1 = makeCommit({ mapId: 'map-order', sequence: 1 })
    const c2 = makeCommit({ mapId: 'map-order', sequence: 2 })
    const c3 = makeCommit({ mapId: 'map-order', sequence: 3 })

    sibling.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit: c1 })
    sibling.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit: c2 })
    sibling.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit: c3 })

    await tick()
    sibling.close()

    expect(host.received.map(c => c.sequence)).toEqual([1, 2, 3])
  })

  it('marks delivered commits as received-from-another-tab', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    const host = makeRecordingHost()
    tab.activate('map-marked', host)

    const sibling = new BroadcastChannel('bm-crosstab-map-marked')
    const commit = makeCommit({ mapId: 'map-marked', sequence: 1 })
    sibling.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit })

    await tick()
    sibling.close()

    expect(host.received).toHaveLength(1)
    expect(tab.wasReceivedFromAnotherTab(commit.id)).toBe(true)
    // Commits this tab never saw return false.
    expect(tab.wasReceivedFromAnotherTab('never-seen-id')).toBe(false)
  })

  it('drops messages whose mapId does not match the active channel', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    const host = makeRecordingHost()
    tab.activate('map-A', host)

    // Defensive: post a message on the active channel but with a different mapId
    // in the commit body. The composable defends against this.
    const local = new BroadcastChannel('bm-crosstab-map-A')
    const commit = makeCommit({ mapId: 'map-B', sequence: 1 })
    local.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit })

    await tick()
    local.close()

    expect(host.received).toHaveLength(0)
  })
})

// ── Echo prevention ────────────────────────────────────────────────────────

describe('useCrossTab  - echo prevention', () => {
  it('local broadcasts do not trigger the local host', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    const host = makeRecordingHost()
    tab.activate('map-echo', host)

    // Simulate a local append: useCommitLog will fire its append listener,
    // which makes useCrossTab broadcast on the channel. The composable's own
    // listener should skip messages whose fromTabId matches its own tabId.
    const log = useCommitLog()
    log.appendCommit(
      { type: 'context:add', payload: { name: 'local', parentUri: log.mapId.value } } as any,
      { type: 'context:remove', payload: { contextUri: 'placeholder' } } as any,
    )

    await tick()

    expect(host.received).toHaveLength(0)
  })

  it('drops messages from this tab even when posted directly', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    const host = makeRecordingHost()
    tab.activate('map-echo-direct', host)

    // Simulate a re-broadcast loop: post a message on the active channel
    // claiming this tab's id. The composable should ignore it.
    const channel = new BroadcastChannel('bm-crosstab-map-echo-direct')
    const commit = makeCommit({ mapId: 'map-echo-direct', sequence: 1 })
    channel.postMessage({ type: 'commit', fromTabId: tab.getTabId(), commit })

    await tick()
    channel.close()

    expect(host.received).toHaveLength(0)
  })
})

// ── Dedup ──────────────────────────────────────────────────────────────────

describe('useCrossTab  - dedup', () => {
  it('drops a commit redelivered with the same id', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    const host = makeRecordingHost()
    tab.activate('map-dedup', host)

    const sibling = new BroadcastChannel('bm-crosstab-map-dedup')
    const commit = makeCommit({ mapId: 'map-dedup', sequence: 1, id: 'fixed-id' })

    sibling.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit })
    sibling.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit })

    await tick()
    sibling.close()

    expect(host.received).toHaveLength(1)
  })
})

// ── Sync push filter integration ──────────────────────────────────────────

describe('useCrossTab + useSyncEngine  - push filter', () => {
  function makeFakeAdapter(): SyncAdapter & {
    pushedCommits: Commit[]
  } {
    const pushed: Commit[] = []
    return {
      pushedCommits: pushed,
      descriptor: { kind: 'cloud', label: 'Fake', icon: 'cloud' },
      async push(_mapId, _branchId, commits, _baseSequence): Promise<PushResult> {
        pushed.push(...commits)
        const last = commits[commits.length - 1]
        return { success: true, newHeadSequence: last ? last.sequence : 0 }
      },
      async pull(): Promise<PullResult> {
        return { success: true, commits: [], remoteHead: 0 }
      },
      async getRemoteHead() {
        return 0
      },
    }
  }

  function makeSyncHost(initialRoot: RootContext): SyncHost {
    return {
      getRoot: () => initialRoot,
      applyFastForward: () => {},
      applyMerged: () => {},
      onConflict: () => {},
    }
  }

  it('skips commits received from a sibling tab when pushing', async () => {
    const { root } = await bootstrapCommitLog('Push Filter Test')
    const tab = useCrossTab()
    const sync = useSyncEngine()
    const adapter = makeFakeAdapter()
    sync.activate(adapter, makeSyncHost(root))

    // Cross-tab installs the push filter on activate.
    const host: CrossTabHost = {
      applyRemoteCommit: (commit) => {
        // Simulate the canvas store's apply path: append to the commit log
        // (using the internal commits.value push that replayRemoteCommit
        // would do  - we synthesize the same effect here).
        const log = useCommitLog()
        log.commits.value.push(commit)
        if (commit.sequence >= log.nextSequence.value) {
          log.nextSequence.value = commit.sequence + 1
        }
      },
    }
    tab.activate(root.uri, host)

    // Sibling tab broadcasts two commits with the SAME deviceId (cross-tab is
    // by definition same-device). The push filter must skip them.
    const sibling = new BroadcastChannel(`bm-crosstab-${root.uri}`)
    const c1 = makeCommit({ mapId: root.uri, sequence: 1, deviceId: 'device-test' })
    const c2 = makeCommit({ mapId: root.uri, sequence: 2, deviceId: 'device-test' })
    sibling.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit: c1 })
    sibling.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit: c2 })

    await tick()
    sibling.close()

    // Now ask the sync engine to push. With the filter, NO commits should
    // reach the adapter  - the originating sibling tab is responsible.
    const ok = await sync.push()
    expect(ok).toBe(true)
    expect(adapter.pushedCommits).toHaveLength(0)
  })

  it('still pushes commits this tab originated locally', async () => {
    const { root } = await bootstrapCommitLog('Push Local Test')
    const tab = useCrossTab()
    const sync = useSyncEngine()
    const adapter = makeFakeAdapter()
    sync.activate(adapter, makeSyncHost(root))

    tab.activate(root.uri, makeRecordingHost())

    // Append a commit locally  - useCrossTab will broadcast it but the local
    // tab doesn't mark its own broadcasts as cross-tab-received, so the push
    // filter does NOT skip them.
    const log = useCommitLog()
    log.appendCommit(
      { type: 'context:add', payload: { name: 'local', parentUri: root.uri } } as any,
      { type: 'context:remove', payload: { contextUri: 'placeholder' } } as any,
    )

    await tick()

    const ok = await sync.push()
    expect(ok).toBe(true)
    expect(adapter.pushedCommits).toHaveLength(1)
  })

  it('clears the push filter on deactivate', async () => {
    const { root } = await bootstrapCommitLog('Filter Cleanup Test')
    const tab = useCrossTab()
    const sync = useSyncEngine()
    const adapter = makeFakeAdapter()
    sync.activate(adapter, makeSyncHost(root))

    tab.activate(root.uri, makeRecordingHost())
    tab.deactivate()

    // After deactivate, the filter is cleared. A locally-appended commit
    // should still push (as the baseline test confirms), and any commit we
    // happen to add to the log directly should also push.
    const log = useCommitLog()
    log.commits.value.push(
      makeCommit({ mapId: root.uri, sequence: 1, deviceId: 'device-test' }),
    )

    const ok = await sync.push()
    expect(ok).toBe(true)
    expect(adapter.pushedCommits).toHaveLength(1)
  })
})

// ── Host failure isolation ─────────────────────────────────────────────────

describe('useCrossTab  - host failure isolation', () => {
  it('continues to receive after a host throws', async () => {
    await bootstrapCommitLog()
    const tab = useCrossTab()
    const host = makeRecordingHost()
    host.throwOnce = true
    tab.activate('map-fail', host)

    const sibling = new BroadcastChannel('bm-crosstab-map-fail')
    const c1 = makeCommit({ mapId: 'map-fail', sequence: 1, id: 'a' })
    const c2 = makeCommit({ mapId: 'map-fail', sequence: 2, id: 'b' })
    sibling.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit: c1 })
    sibling.postMessage({ type: 'commit', fromTabId: 'sibling-tab', commit: c2 })

    await tick()
    sibling.close()

    // c1 threw → not delivered. c2 succeeded → delivered.
    expect(host.received.map(c => c.id)).toEqual(['b'])
    // The failed commit is still marked as received (so the sync engine
    // won't push it  - the originating tab will).
    expect(tab.wasReceivedFromAnotherTab('a')).toBe(true)
  })
})
