/**
 * Regression tests for the sync cursor persistence fix  - the back/forward
 * during AI-dispatch bug.
 *
 * Before this fix:
 *  - `lastSyncedSequence` lived only in the engine singleton, started at 0
 *    on every fresh page load, and was never persisted to IDB.
 *  - After a refresh, the engine re-pushed every local commit from
 *    sequence 0, which 409'd against whatever the server already had.
 *  - The user had no UI to recover  - the engine just sat in 'conflict'
 *    forever.
 *
 * After the fix:
 *  - `saveSyncCursor` / `loadSyncCursor` / `clearSyncCursor` round-trip
 *    via the `config` store, keyed by `sync-cursor:${mapId}:${branchId}`
 *  - `useSyncEngine.primeCursor(mapId, branchId)` is called by the app
 *    before activation, restoring the cursor from IDB
 *  - Every successful push/pull/fast-forward/merge calls `persistCursor()`
 *    so the cursor is always durable
 *  - `useSyncEngine.retryNow()` rewinds to the persisted cursor and runs
 *    a full sync, used by the manual "Retry sync" button
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useSyncEngine, resetSyncEngineSingleton } from '../useSyncEngine'
import type { SyncHost } from '../useSyncEngine'
import type { SyncAdapter, PushResult, PullResult } from '../syncTypes'
import { useCommitLog, resetCommitLogSingleton } from '../useCommitLog'
import { saveSyncCursor, loadSyncCursor, clearSyncCursor } from '../idbHelpers'
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

async function bootstrapCommitLog(): Promise<{ root: RootContext }> {
  const root = createEmptyRootContext('Cursor Test')
  const layout = emptyLayout(root.uri)
  const log = useCommitLog()
  log.reset()
  log.setDeviceId('device-test')
  await log.initFromSnapshot(root.uri, root, layout)
  return { root }
}

function makeFakeAdapter(initial?: {
  push?: PushResult
  pull?: PullResult
  pushImpl?: (commits: Commit[], baseSequence: number) => PushResult
}): SyncAdapter & {
  pushCalls: Array<{ baseSequence: number; commits: Commit[] }>
  pullCalls: Array<{ sinceSequence: number }>
} {
  const pushCalls: Array<{ baseSequence: number; commits: Commit[] }> = []
  const pullCalls: Array<{ sinceSequence: number }> = []
  return {
    pushCalls,
    pullCalls,
    descriptor: { kind: 'cloud', label: 'Fake', icon: 'cloud' },
    async push(_mapId, _branchId, commits, baseSequence): Promise<PushResult> {
      pushCalls.push({ baseSequence, commits })
      if (initial?.pushImpl) return initial.pushImpl(commits, baseSequence)
      return initial?.push ?? {
        success: true,
        newHeadSequence: commits[commits.length - 1]?.sequence ?? baseSequence,
      }
    },
    async pull(_mapId, _branchId, sinceSequence): Promise<PullResult> {
      pullCalls.push({ sinceSequence })
      return initial?.pull ?? { success: true, commits: [], remoteHead: sinceSequence }
    },
    async getRemoteHead() {
      return 0
    },
  }
}

function makeHost(initialRoot: RootContext): SyncHost {
  return {
    getRoot: () => initialRoot,
    applyFastForward: () => {},
    applyMerged: () => {},
    onConflict: () => {},
  }
}

beforeEach(async () => {
  await resetIdb()
  resetCommitLogSingleton()
  resetSyncEngineSingleton()
})

afterEach(async () => {
  resetSyncEngineSingleton()
})

// ── idbHelpers round-trip ──────────────────────────────────────────────────

describe('sync cursor  - idbHelpers round-trip', () => {
  it('loads 0 when no cursor has been saved', async () => {
    const seq = await loadSyncCursor('map-1', 'main')
    expect(seq).toBe(0)
  })

  it('saves and loads a cursor round-trip', async () => {
    await saveSyncCursor('map-1', 'main', 42)
    expect(await loadSyncCursor('map-1', 'main')).toBe(42)
  })

  it('scopes cursor by mapId and branchId', async () => {
    await saveSyncCursor('map-1', 'main', 10)
    await saveSyncCursor('map-1', 'feature', 20)
    await saveSyncCursor('map-2', 'main', 30)

    expect(await loadSyncCursor('map-1', 'main')).toBe(10)
    expect(await loadSyncCursor('map-1', 'feature')).toBe(20)
    expect(await loadSyncCursor('map-2', 'main')).toBe(30)
  })

  it('overwrites an existing cursor on re-save', async () => {
    await saveSyncCursor('map-1', 'main', 5)
    await saveSyncCursor('map-1', 'main', 15)
    expect(await loadSyncCursor('map-1', 'main')).toBe(15)
  })

  it('clearSyncCursor removes the entry', async () => {
    await saveSyncCursor('map-1', 'main', 7)
    await clearSyncCursor('map-1', 'main')
    expect(await loadSyncCursor('map-1', 'main')).toBe(0)
  })
})

// ── Engine primeCursor ────────────────────────────────────────────────────

describe('useSyncEngine  - primeCursor', () => {
  it('restores the persisted cursor', async () => {
    const { root } = await bootstrapCommitLog()
    await saveSyncCursor(root.uri, 'main', 42)

    const engine = useSyncEngine()
    await engine.primeCursor(root.uri, 'main')

    expect(engine.lastSyncedSequence.value).toBe(42)
  })

  it('leaves cursor at 0 when nothing is persisted', async () => {
    const { root } = await bootstrapCommitLog()

    const engine = useSyncEngine()
    await engine.primeCursor(root.uri, 'main')

    expect(engine.lastSyncedSequence.value).toBe(0)
  })

  it('a refresh cycle (reset → primeCursor) restores the cursor', async () => {
    const { root } = await bootstrapCommitLog()
    await saveSyncCursor(root.uri, 'main', 99)

    // Session 1: prime + activate
    let engine = useSyncEngine()
    await engine.primeCursor(root.uri, 'main')
    expect(engine.lastSyncedSequence.value).toBe(99)

    // Simulate a refresh: reset the singleton (wipes engine in-memory state)
    resetSyncEngineSingleton()
    engine = useSyncEngine()
    expect(engine.lastSyncedSequence.value).toBe(0) // fresh start

    // Session 2: prime again  - restored from IDB
    await engine.primeCursor(root.uri, 'main')
    expect(engine.lastSyncedSequence.value).toBe(99)
  })
})

// ── Push / pull persist the cursor ────────────────────────────────────────

describe('useSyncEngine  - cursor persistence on success', () => {
  async function waitForPersist(): Promise<void> {
    // persistCursor is fire-and-forget; flush microtasks so the IDB write
    // completes before we assert.
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  async function appendCommit(label: string): Promise<void> {
    const log = useCommitLog()
    log.appendCommit(
      { type: 'context:add', payload: { uri: `c-${label}`, name: label, parentUri: log.mapId.value } },
      { type: 'context:remove', payload: { contextUri: `c-${label}` } },
    )
  }

  it('saves the cursor to IDB after a successful push', async () => {
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()
    const adapter = makeFakeAdapter()
    engine.activate(adapter, makeHost(root))

    await appendCommit('A')
    await engine.push()
    await waitForPersist()

    const persisted = await loadSyncCursor(root.uri, 'main')
    expect(persisted).toBeGreaterThan(0)
    expect(persisted).toBe(engine.lastSyncedSequence.value)
  })

  it('saves the cursor after a fast-forward pull', async () => {
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()
    const remoteCommit: Commit = {
      id: 'remote-1',
      mapId: root.uri,
      sequence: 5,
      command: { type: 'context:add', payload: { uri: 'remote-c', name: 'R', parentUri: root.uri } } as any,
      inverse: { type: 'context:remove', payload: { contextUri: 'remote-c' } } as any,
      timestamp: new Date().toISOString(),
      deviceId: 'other-device',
      branchId: 'main',
      parentId: null,
    }
    const adapter = makeFakeAdapter({
      pull: { success: true, commits: [remoteCommit], remoteHead: 5 },
    })
    engine.activate(adapter, makeHost(root))

    await engine.pull()
    await waitForPersist()

    expect(engine.lastSyncedSequence.value).toBe(5)
    expect(await loadSyncCursor(root.uri, 'main')).toBe(5)
  })

  it('the persisted cursor survives a simulated refresh', async () => {
    const { root } = await bootstrapCommitLog()

    // Session 1
    let engine = useSyncEngine()
    const adapter1 = makeFakeAdapter()
    engine.activate(adapter1, makeHost(root))
    await appendCommit('A')
    await appendCommit('B')
    await engine.push()
    await waitForPersist()
    const cursorAfterSession1 = engine.lastSyncedSequence.value
    expect(cursorAfterSession1).toBeGreaterThan(0)

    // Refresh: engine singleton wiped, but IDB persists
    resetSyncEngineSingleton()

    // Session 2  - the app's wiring calls primeCursor before activate
    engine = useSyncEngine()
    await engine.primeCursor(root.uri, 'main')
    expect(engine.lastSyncedSequence.value).toBe(cursorAfterSession1)
  })
})

// ── retryNow: the user-facing recovery path ───────────────────────────────

describe('useSyncEngine  - retryNow (manual recovery)', () => {
  it('clears error status and runs a full sync cycle', async () => {
    const { root } = await bootstrapCommitLog()
    const engine = useSyncEngine()

    // First push fails, second succeeds. A fresh test adapter to control the
    // per-call behavior.
    let pushCount = 0
    const adapter = makeFakeAdapter({
      pushImpl: () => {
        pushCount++
        if (pushCount === 1) {
          return { success: false, newHeadSequence: 0, error: 'Remote has newer changes', conflict: true }
        }
        return { success: true, newHeadSequence: 1 }
      },
    })
    engine.activate(adapter, makeHost(root))

    // Append a commit so push has something to send
    const log = useCommitLog()
    log.appendCommit(
      { type: 'context:add', payload: { uri: 'r', name: 'R', parentUri: log.mapId.value } } as any,
      { type: 'context:remove', payload: { contextUri: 'r' } } as any,
    )

    // First push → conflict
    const firstOk = await engine.push()
    expect(firstOk).toBe(false)
    expect(engine.status.value).toBe('conflict')

    // User clicks "Retry sync" → pull + push
    const retryOk = await engine.retryNow()
    expect(retryOk).toBe(true)
    expect(engine.status.value).toBe('idle')
    // push was called twice: once in the original attempt, once via retryNow's full cycle
    expect(pushCount).toBeGreaterThanOrEqual(2)
  })
})
