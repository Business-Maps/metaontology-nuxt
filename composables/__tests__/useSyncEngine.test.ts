/**
 * Tests for `useSyncEngine`  - the layer-owned sync engine.
 *
 * Coverage:
 *   - Push debounce (schedulePush → wait → push fires once)
 *   - Conflict-pull-merge (diverged state → merge → applyMerged called)
 *   - Exponential backoff (push failure → retry with increasing delay)
 *
 * The engine is a module-level singleton. Each test resets it via
 * `resetSyncEngineSingleton()` (also resets the commit log).
 *
 * Fake dependencies:
 *   - A `FakeAdapter` that records push/pull calls and returns canned results
 *   - A `FakeHost` that captures applyFastForward / applyMerged / onConflict calls
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSyncEngine, resetSyncEngineSingleton } from '../useSyncEngine'
import type { SyncHost } from '../useSyncEngine'
import type { SyncAdapter, PushResult, PullResult } from '../syncTypes'
import { useCommitLog } from '../useCommitLog'
import { createEmptyRootContext } from '@businessmaps/metaontology/engine/apply'
import type { RootContext } from '@businessmaps/metaontology/types/context'
import type { Commit } from '@businessmaps/metaontology/types/commits'
import type { MergeResult } from '@businessmaps/metaontology/types/branch'
import { resetIdb } from '../../__tests__/helpers/resetIdb'

// Local stand-in for BM's CanvasLayout  - the commit log treats layouts as
// opaque `unknown`, so tests don't need to reach into layers/bm for the type.
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

// ── Fake adapter ────────────────────────────────────────────────────────────

interface FakeAdapterState {
  pushCalls: Array<{ mapId: string; branchId: string; commits: Commit[]; baseSequence: number }>
  pullCalls: Array<{ mapId: string; branchId: string; sinceSequence: number }>
  nextPushResult: PushResult
  nextPullResult: PullResult
  pushImpl?: (commits: Commit[]) => PushResult  // per-call override
}

function makeFakeAdapter(initial?: Partial<FakeAdapterState>): SyncAdapter & { state: FakeAdapterState } {
  const state: FakeAdapterState = {
    pushCalls: [],
    pullCalls: [],
    nextPushResult: { success: true, newHeadSequence: 0 },
    nextPullResult: { success: true, commits: [], remoteHead: 0 },
    ...initial,
  }

  const adapter: SyncAdapter & { state: FakeAdapterState } = {
    state,
    descriptor: { kind: 'cloud', label: 'Fake Cloud', icon: 'cloud' },
    async push(mapId, branchId, commits, baseSequence) {
      state.pushCalls.push({ mapId, branchId, commits, baseSequence })
      if (state.pushImpl) return state.pushImpl(commits)
      return state.nextPushResult
    },
    async pull(mapId, branchId, sinceSequence) {
      state.pullCalls.push({ mapId, branchId, sinceSequence })
      return state.nextPullResult
    },
    async getRemoteHead() {
      return 0
    },
  }
  return adapter
}

// ── Fake host ───────────────────────────────────────────────────────────────

interface FakeHostState {
  root: RootContext
  applyFastForwardCalls: Commit[][]
  applyMergedCalls: RootContext[]
  onConflictCalls: MergeResult[]
}

function makeFakeHost(initialRoot: RootContext): SyncHost & { state: FakeHostState } {
  const state: FakeHostState = {
    root: initialRoot,
    applyFastForwardCalls: [],
    applyMergedCalls: [],
    onConflictCalls: [],
  }
  const host: SyncHost & { state: FakeHostState } = {
    state,
    getRoot: () => state.root,
    applyFastForward: (commits) => {
      state.applyFastForwardCalls.push(commits)
    },
    applyMerged: (mergedModel) => {
      state.applyMergedCalls.push(mergedModel)
      state.root = mergedModel
    },
    onConflict: (result) => {
      state.onConflictCalls.push(result)
    },
  }
  return host
}

// ── Shared setup ────────────────────────────────────────────────────────────

async function bootstrapCommitLog(name = 'Sync Test'): Promise<{ root: RootContext; layout: TestLayout }> {
  const root = createEmptyRootContext(name)
  const layout = emptyLayout(root.uri)
  const log = useCommitLog()
  log.reset()
  log.setDeviceId('device-test')
  await log.initFromSnapshot(root.uri, root, layout)
  return { root, layout }
}

beforeEach(async () => {
  await resetIdb()
  resetSyncEngineSingleton()
})

afterEach(() => {
  vi.useRealTimers()
  resetSyncEngineSingleton()
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('useSyncEngine  - activation', () => {
  it('starts inactive with default state', () => {
    const engine = useSyncEngine()
    expect(engine.enabled.value).toBe(false)
    expect(engine.status.value).toBe('idle')
    expect(engine.target.value).toBeNull()
    expect(engine.lastSyncedSequence.value).toBe(0)
  })

  it('drains the backlog when activating with pre-existing unsynced commits', async () => {
    // Regression for the "refresh-before-sync-fires strands commits" bug.
    //
    // Scenario: user dispatches a command, unload handlers flush the commit
    // to IDB, then they refresh before the 5-second debounce elapses. On
    // the new session, `loadByContextId` replays from IDB so the commit
    // log has N unsynced commits, and `useCollabWiring.activateForMap`
    // then calls `engine.activate(...)`. Before this fix, the engine
    // didn't know about those commits (the app-side watch was initialized
    // AFTER the commits loaded), and they stayed stranded past
    // `lastSyncedSequence` forever.
    //
    // The fix: `activate()` checks `pendingCount` and fires a push if
    // there's a backlog. This test simulates the bug by appending commits
    // BEFORE activating the engine.
    const { root } = await bootstrapCommitLog()
    const log = useCommitLog()

    // Simulate two pre-existing unsynced commits loaded from IDB
    log.appendCommit(
      { type: 'context:add', payload: { uri: 'pre-1', name: 'Pre 1', parentUri: root.uri } } as any,
      { type: 'context:remove', payload: { contextUri: 'pre-1' } } as any,
    )
    log.appendCommit(
      { type: 'context:add', payload: { uri: 'pre-2', name: 'Pre 2', parentUri: root.uri } } as any,
      { type: 'context:remove', payload: { contextUri: 'pre-2' } } as any,
    )

    const engine = useSyncEngine()
    const adapter = makeFakeAdapter({
      nextPushResult: { success: true, newHeadSequence: 2 },
    })
    const host = makeFakeHost(root)

    // Cursor is still at 0  - all commits look pending
    expect(engine.lastSyncedSequence.value).toBe(0)

    engine.activate(adapter, host)

    // Engine fires push() immediately (fire-and-forget). Flush microtasks
    // so the async push resolves before we assert.
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(adapter.state.pushCalls.length).toBe(1)
    expect(adapter.state.pushCalls[0].commits.length).toBe(2)
    expect(adapter.state.pushCalls[0].baseSequence).toBe(0)
  })

  it('does not fire push on activate when the backlog is empty', async () => {
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()
    const adapter = makeFakeAdapter()
    const host = makeFakeHost(root)

    engine.activate(adapter, host)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(adapter.state.pushCalls.length).toBe(0)
  })

  it('activate(adapter, host) sets enabled + target', async () => {
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()
    const adapter = makeFakeAdapter()
    const host = makeFakeHost(root)

    engine.activate(adapter, host)

    expect(engine.enabled.value).toBe(true)
    expect(engine.target.value).toEqual(adapter.descriptor)
  })

  it('deactivate clears adapter + target + status', async () => {
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()
    engine.activate(makeFakeAdapter(), makeFakeHost(root))
    engine.deactivate()

    expect(engine.enabled.value).toBe(false)
    expect(engine.target.value).toBeNull()
  })
})

describe('useSyncEngine  - push', () => {
  it('push collects commits after the last synced sequence', async () => {
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()
    const adapter = makeFakeAdapter({
      nextPushResult: { success: true, newHeadSequence: 2 },
    })
    const host = makeFakeHost(root)
    engine.activate(adapter, host)

    // Append a couple of commits to the log
    const log = useCommitLog()
    log.appendCommit(
      { type: 'context:add', payload: { name: 'A', parentUri: root.uri } },
      { type: 'context:remove', payload: { contextUri: 'x' } },
    )
    log.appendCommit(
      { type: 'context:add', payload: { name: 'B', parentUri: root.uri } },
      { type: 'context:remove', payload: { contextUri: 'y' } },
    )

    const ok = await engine.push()
    expect(ok).toBe(true)
    expect(adapter.state.pushCalls).toHaveLength(1)
    expect(adapter.state.pushCalls[0]!.commits).toHaveLength(2)
    expect(engine.lastSyncedSequence.value).toBe(2)
    expect(engine.status.value).toBe('idle')
  })

  it('push returns true and skips the adapter when there are no new commits', async () => {
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()
    const adapter = makeFakeAdapter()
    engine.activate(adapter, makeFakeHost(root))

    const ok = await engine.push()
    expect(ok).toBe(true)
    expect(adapter.state.pushCalls).toHaveLength(0)
  })

  it('schedulePush debounces and fires push once after the timer elapses', async () => {
    // IDB bootstrap runs on real timers  - fake-indexeddb uses internal
    // timers that hang under vi.useFakeTimers if enabled too early.
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()
    const adapter = makeFakeAdapter({
      nextPushResult: { success: true, newHeadSequence: 1 },
    })
    engine.activate(adapter, makeFakeHost(root))

    const log = useCommitLog()
    log.appendCommit(
      { type: 'context:add', payload: { name: 'A', parentUri: root.uri } },
      { type: 'context:remove', payload: { contextUri: 'x' } },
    )

    // Switch to fake timers now  - only the debounce window needs them
    vi.useFakeTimers()

    // Multiple rapid schedulePush calls should collapse into one push
    engine.schedulePush()
    engine.schedulePush()
    engine.schedulePush()

    // Nothing fired yet
    expect(adapter.state.pushCalls).toHaveLength(0)

    // Advance past debounce window; flush microtasks to let async push settle
    await vi.advanceTimersByTimeAsync(5_001)
    expect(adapter.state.pushCalls).toHaveLength(1)
  })
})

describe('useSyncEngine  - pull fast-forward', () => {
  it('fast-forwards via host.applyFastForward when local has no unsynced commits', async () => {
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()

    const remoteCommit: Commit = {
      id: 'r-1',
      mapId: root.uri,
      sequence: 1,
      command: { type: 'context:add', payload: { name: 'Remote', parentUri: root.uri } },
      inverse: { type: 'context:remove', payload: { contextUri: 'x' } },
      timestamp: '2026-01-02',
      deviceId: 'device-remote',
      branchId: 'main',
      parentId: 'genesis',
    }

    const adapter = makeFakeAdapter({
      nextPullResult: { success: true, commits: [remoteCommit], remoteHead: 1 },
    })
    const host = makeFakeHost(root)
    engine.activate(adapter, host)

    const ok = await engine.pull()

    expect(ok).toBe(true)
    expect(host.state.applyFastForwardCalls).toHaveLength(1)
    expect(host.state.applyFastForwardCalls[0]).toHaveLength(1)
    expect(host.state.applyFastForwardCalls[0]![0]!.id).toBe('r-1')
    expect(engine.lastSyncedSequence.value).toBe(1)
    expect(engine.status.value).toBe('idle')
  })

  it('treats empty pull as a no-op success', async () => {
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()
    const adapter = makeFakeAdapter({
      nextPullResult: { success: true, commits: [], remoteHead: 0 },
    })
    const host = makeFakeHost(root)
    engine.activate(adapter, host)

    const ok = await engine.pull()

    expect(ok).toBe(true)
    expect(host.state.applyFastForwardCalls).toHaveLength(0)
    expect(host.state.applyMergedCalls).toHaveLength(0)
  })
})

describe('useSyncEngine  - pull divergent merge', () => {
  it('runs a model-only three-way merge and calls applyMerged on success', async () => {
    const { root } = await bootstrapCommitLog('Diverged')
    const engine = useSyncEngine()
    const host = makeFakeHost(root)

    // Local: append a local commit (our side has diverged from lastSynced=0)
    const log = useCommitLog()
    log.appendCommit(
      { type: 'context:add', payload: { name: 'Local', parentUri: root.uri } },
      { type: 'context:remove', payload: { contextUri: 'local-1' } },
    )
    // Update host.root to reflect the local edit (the engine reads via host.getRoot)
    host.state.root = {
      ...root,
      contexts: {
        'local-1': {
          uri: 'local-1',
          name: 'Local',
          description: '',
          parentUri: root.uri,
          symbols: [],
          facets: { things: [], personas: [], ports: [], actions: [], workflows: [], interfaces: [], events: [], measures: [], functions: [], datasources: [], pipelines: [] },
        } as any,
      },
    }

    // Remote: a commit that adds a DIFFERENT context
    const remoteCommit: Commit = {
      id: 'r-1',
      mapId: root.uri,
      sequence: 1,
      command: { type: 'context:add', payload: { name: 'Remote', uri: 'remote-1', parentUri: root.uri } },
      inverse: { type: 'context:remove', payload: { contextUri: 'remote-1' } },
      timestamp: '2026-01-02',
      deviceId: 'device-remote',
      branchId: 'main',
      parentId: 'genesis',
    }

    const adapter = makeFakeAdapter({
      nextPullResult: { success: true, commits: [remoteCommit], remoteHead: 1 },
    })
    engine.activate(adapter, host)

    const ok = await engine.pull()

    expect(ok).toBe(true)
    expect(host.state.applyMergedCalls).toHaveLength(1)
    expect(host.state.onConflictCalls).toHaveLength(0)
    // Merged model includes both local + remote contexts
    const merged = host.state.applyMergedCalls[0]!
    const ctxNames = Object.values(merged.contexts).map(c => c.name).sort()
    expect(ctxNames).toContain('Local')
    expect(ctxNames).toContain('Remote')
    expect(engine.status.value).toBe('idle')
  })
})

describe('useSyncEngine  - exponential backoff on push failure', () => {
  it('retries push with increasing delay after network errors', async () => {
    // IDB bootstrap runs on real timers  - see debounce test comment.
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()

    // Adapter fails the first two pushes, succeeds on the third
    let callCount = 0
    const adapter = makeFakeAdapter()
    adapter.state.pushImpl = () => {
      callCount++
      if (callCount < 3) {
        throw new Error('Network down')
      }
      return { success: true, newHeadSequence: 1 }
    }
    engine.activate(adapter, makeFakeHost(root))

    const log = useCommitLog()
    log.appendCommit(
      { type: 'context:add', payload: { name: 'X', parentUri: root.uri } },
      { type: 'context:remove', payload: { contextUri: 'x' } },
    )

    // Switch to fake timers now  - only the retry delays need them
    vi.useFakeTimers()

    // First push: fails, schedules retry at ~5s
    await engine.push()
    expect(adapter.state.pushCalls).toHaveLength(1)
    expect(engine.status.value).toBe('error')

    // Advance past first retry delay (5s base)
    await vi.advanceTimersByTimeAsync(5_100)
    expect(adapter.state.pushCalls).toHaveLength(2)

    // Advance past second retry delay (10s  - 2x base)
    await vi.advanceTimersByTimeAsync(10_100)
    expect(adapter.state.pushCalls).toHaveLength(3)
    expect(engine.status.value).toBe('idle')
    expect(engine.lastSyncedSequence.value).toBe(1)
  })
})
