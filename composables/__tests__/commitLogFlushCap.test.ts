/**
 * Regression tests for the commit log flush cap  - the debounce starvation
 * half of the back/forward-during-AI-dispatch bug.
 *
 * Before this fix:
 *  - `scheduleFlush` used `useDebounceFn(..., 800)`, which RESET on every
 *    append. When the AI rapid-fired 200 tool calls in ~10 seconds, no
 *    append was more than 800ms after the previous one, so the debouncer
 *    never fired and `pendingCommits` grew unbounded.
 *  - On navigation or refresh, those pending commits were never flushed to
 *    IDB  - they were simply lost, reducing the user's reported pending
 *    count from 200+ to whatever had managed to flush earlier.
 *
 * After this fix:
 *  - A hard cap (`PENDING_FLUSH_CAP = 25`) forces an immediate (bypass-
 *    debounce) flush once the pending buffer exceeds the threshold. Under
 *    rapid dispatch the pending buffer can never grow beyond the cap + 1
 *    commit, so worst-case loss on a crash is 25 commits instead of 200+.
 *  - `flushPending` is exposed so callers can manually drain (used by the
 *    unload handlers and by test fixtures).
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { useCommitLog, resetCommitLogSingleton } from '../useCommitLog'
import { loadCommitsSince } from '../idbHelpers'
import { createEmptyRootContext } from '@businessmaps/metaontology/engine/apply'
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

async function waitMicrotasks(): Promise<void> {
  // Cap-triggered flush is fire-and-forget  - wait a few macrotasks for the
  // IDB transaction to complete before asserting.
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

function dispatchAppend(label: string) {
  const log = useCommitLog()
  log.appendCommit(
    { type: 'context:add', payload: { uri: `c-${label}`, name: label, parentUri: log.mapId.value } } as any,
    { type: 'context:remove', payload: { contextUri: `c-${label}` } } as any,
  )
}

beforeEach(async () => {
  await resetIdb()
  resetCommitLogSingleton()
})

describe('useCommitLog  - flush cap prevents debounce starvation', () => {
  it('exposes flushPending on the returned API', async () => {
    const log = useCommitLog()
    expect(typeof log.flushPending).toBe('function')
  })

  it('flushes immediately when pending exceeds the cap (rapid AI dispatch)', async () => {
    const root = createEmptyRootContext('Flush Cap Test')
    const log = useCommitLog()
    log.reset()
    log.setDeviceId('device-test')
    await log.initFromSnapshot(root.uri, root, emptyLayout(root.uri))

    // Dispatch 30 commits rapidly. Without the cap, the 800ms debounce
    // resets on every call and NOTHING flushes. With the cap (25), the
    // 25th append triggers an immediate write.
    for (let i = 0; i < 30; i++) {
      dispatchAppend(`ctx-${i}`)
    }

    await waitMicrotasks()

    // At least the first ~25 commits should have landed in IDB. The
    // remainder (5) may still be in pendingCommits waiting for the next
    // debounce cycle or cap trigger.
    const stored = await loadCommitsSince(root.uri, 'main', 0)
    expect(stored.length).toBeGreaterThanOrEqual(25)
  })

  it('manual flushPending drains all pending commits to IDB', async () => {
    const root = createEmptyRootContext('Manual Flush Test')
    const log = useCommitLog()
    log.reset()
    log.setDeviceId('device-test')
    await log.initFromSnapshot(root.uri, root, emptyLayout(root.uri))

    // Append 5 commits  - below the cap, so nothing auto-flushes.
    for (let i = 0; i < 5; i++) {
      dispatchAppend(`ctx-${i}`)
    }

    // Before flushPending, only the genesis checkpoint is in IDB  - the
    // 5 commits are still in the pending buffer.
    let stored = await loadCommitsSince(root.uri, 'main', 0)
    expect(stored.length).toBe(0)

    // Manual drain → all 5 hit IDB.
    await log.flushPending()
    stored = await loadCommitsSince(root.uri, 'main', 0)
    expect(stored.length).toBe(5)
  })

  it('simulates an unload path: commits dispatched then flushPending then "navigate"', async () => {
    const root = createEmptyRootContext('Unload Simulation')
    const log = useCommitLog()
    log.reset()
    log.setDeviceId('device-test')
    await log.initFromSnapshot(root.uri, root, emptyLayout(root.uri))

    // Dispatch 10 commits  - below the cap, would normally sit in pending
    for (let i = 0; i < 10; i++) {
      dispatchAppend(`pre-unload-${i}`)
    }

    // Simulate the unload handler firing: flushPending
    await log.flushPending()

    // Simulate a refresh: reset the singleton and reload from IDB
    resetCommitLogSingleton()
    const newLog = useCommitLog()
    const state = await newLog.loadFromStorage(root.uri)
    expect(state).not.toBeNull()
    // All 10 commits survived the "unload"
    expect(newLog.commits.value.length).toBe(10)
  })

  it('does NOT double-persist commits across multiple flush calls', async () => {
    const root = createEmptyRootContext('Idempotent Flush')
    const log = useCommitLog()
    log.reset()
    log.setDeviceId('device-test')
    await log.initFromSnapshot(root.uri, root, emptyLayout(root.uri))

    dispatchAppend('a')
    dispatchAppend('b')
    dispatchAppend('c')

    // Flush, then flush again (double-trigger doesn't re-write)
    await log.flushPending()
    await log.flushPending()
    await log.flushPending()

    const stored = await loadCommitsSince(root.uri, 'main', 0)
    expect(stored.length).toBe(3)
    // Each commit has a unique id  - no duplicates
    const ids = stored.map(c => c.id)
    expect(new Set(ids).size).toBe(3)
  })
})
