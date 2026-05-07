import { ref, readonly, computed } from 'vue'
import { useCommitLog } from './useCommitLog'
import { saveSyncCursor, loadSyncCursor } from './idbHelpers'
import { threeWayMerge } from '@businessmaps/metaontology/engine/merge'
import type { RootContext } from '@businessmaps/metaontology/types/context'
import type { Commit, Checkpoint } from '@businessmaps/metaontology/types/commits'
import type { MergeResult } from '@businessmaps/metaontology/types/branch'
import type { SyncStatus, SyncTargetDescriptor, SyncAdapter, SyncErrorCategory } from './syncTypes'
import { classifySyncError, friendlySyncErrorMessage } from './syncTypes'

// Sync-related types (`SyncStatus`, `SyncTargetDescriptor`, `SyncAdapter`,
// `PushResult`, `PullResult`) are owned by `./syncTypes` - import them from
// there directly. This file does not re-export them to avoid double-auto-
// import warnings in Nuxt (the layer's composables folder auto-imports every
// file, so re-exporting creates a duplicate).

// ── SyncHost: app-side coupling via dependency injection ────────────────────
//
// The sync engine needs to drive app-side state mutations (apply a fast-forward
// of remote commits, apply a merged model, surface conflicts for user
// resolution). The `SyncHost` interface is the narrow seam: the consuming app
// implements it and passes an instance to `activate()`. The engine owns its own
// status and retry state; it delegates side effects to the host.

export interface SyncHost {
  /** Read the current local model state (our side of the merge). */
  getRoot(): RootContext
  /** Fast-forward: replay remote commits into local state. The host owns
   *  layout replay, awareness marking, and persistence scheduling. */
  applyFastForward(commits: Commit[]): void
  /** Three-way merge succeeded: install the merged model into local state.
   *  The host preserves the current layout (sync merge is model-only). */
  applyMerged(mergedModel: RootContext): void
  /** Three-way merge produced conflicts: expose the result for UI resolution. */
  onConflict(result: MergeResult): void
}

// ── Module-level singleton state ────────────────────────────────────────────

const status = ref<SyncStatus>('idle')
const lastSyncedSequence = ref(0)
const lastSyncedAt = ref<string | null>(null)
const lastError = ref<string | null>(null)
const lastErrorCategory = ref<SyncErrorCategory | null>(null)
const enabled = ref(false)
const target = ref<SyncTargetDescriptor | null>(null)

// Track which error categories we've already logged to the browser console
// since the last successful sync. The retry loop fires every 5–60s; without
// throttling, a CORS-blocked R2 bucket fills the console with hundreds of
// identical fetch failures across a single tab session. We log the first
// occurrence of each category at info level (no scary red errors for known
// transient issues), then go quiet until the category changes or sync
// recovers. The user can still inspect the live state via the branch
// manager dropdown - it always reflects the latest error.
const loggedErrorCategories = new Set<SyncErrorCategory>()

let activeAdapter: SyncAdapter | null = null
let activeHost: SyncHost | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0

// Push filter - pluggable predicate that excludes commits from the push set.
//
// `useCrossTab` sets this to skip commits that were received via
// BroadcastChannel from a sibling tab on the same device. Without this, two
// tabs on the same device would each push the other's commits to the cloud,
// doubling traffic and creating phantom conflicts.
//
// The engine itself does not know about cross-tab - it just runs the filter.
// `null` means "no filter, push everything past lastSyncedSequence."
type PushFilter = (commit: Commit) => boolean
let pushFilter: PushFilter | null = null

const SYNC_DEBOUNCE_MS = 5_000
const RETRY_BASE_MS = 5_000
const RETRY_CAP_MS = 60_000
const RETRY_MAX_ATTEMPTS = 5

// ── Retry helpers ───────────────────────────────────────────────────────────

function retryDelay(): number {
  return Math.min(RETRY_BASE_MS * Math.pow(2, retryCount), RETRY_CAP_MS)
}

function resetRetry() {
  retryCount = 0
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  // Successful sync clears the throttle so subsequent failures of any
  // category get a fresh log line.
  loggedErrorCategories.clear()
}

function scheduleRetry(fn: () => Promise<boolean>) {
  if (retryCount >= RETRY_MAX_ATTEMPTS) {
    // Stay quiet on the final attempt - the dropdown's "Sync paused" message
    // tells the user. Repeated console.warns from the engine just add noise.
    return
  }
  const delay = retryDelay()
  retryCount++
  retryTimer = setTimeout(() => fn(), delay)
}

/**
 * Record a sync failure: classify, store the category, throttle the console
 * log so we only emit one line per (category × retry-cycle) instead of one
 * per attempt. CORS errors against R2 fill the console with ~10 lines per
 * push attempt without this; throttling brings it down to 1.
 */
function recordSyncError(context: 'push' | 'pull', e: unknown, mapId: string, branchId: string) {
  const category = classifySyncError(e)
  lastErrorCategory.value = category
  lastError.value = friendlySyncErrorMessage(category)

  if (loggedErrorCategories.has(category)) return
  loggedErrorCategories.add(category)

  // Use info level for known transient categories - these aren't bugs, they
  // are environmental conditions. Reserve `console.error` for truly unknown
  // failures the developer needs to investigate.
  const detail = e instanceof Error ? e.message : String(e)
  if (category === 'network' || category === 'cors' || category === 'crypto') {
    console.warn(`[Sync] ${context} paused: ${friendlySyncErrorMessage(category)}`, { mapId, branchId, detail })
  } else if (category === 'unknown') {
    console.error(`[Sync] ${context} failed (uncategorized):`, { mapId, branchId, error: e })
  } else {
    console.warn(`[Sync] ${context} ${category}: ${friendlySyncErrorMessage(category)}`, { mapId, branchId, detail })
  }
}

// ── Composable ──────────────────────────────────────────────────────────────

export function useSyncEngine() {
  const commitLog = useCommitLog()

  const pendingCount = computed(() => {
    if (!enabled.value) return 0
    return commitLog.commits.value.filter(c => c.sequence > lastSyncedSequence.value).length
  })

  /** Activate sync with an adapter and an app-side host. */
  function activate(adapter: SyncAdapter, host: SyncHost) {
    activeAdapter = adapter
    activeHost = host
    target.value = adapter.descriptor
    enabled.value = true
    resetRetry()

    // Drain any backlog left from the previous session.
    //
    // Scenario: the user dispatches a command, an unload handler flushes
    // the pending commit to IDB, then they refresh BEFORE the 5-second
    // sync debounce fires. On the new page load, `loadByContextId` replays
    // from IDB and `useCollabWiring.activateForMap` captures
    // `lastCommitCount = store.commitLog.length` as a baseline - which
    // means the watcher only fires on FUTURE dispatches, not the ones
    // already in the log. Without this check, those pre-existing commits
    // would sit past `lastSyncedSequence` forever, waiting for a local
    // dispatch that may never come.
    //
    // `pendingCount` reads `commitLog.commits.value` (already loaded from
    // IDB by the caller) against the freshly-primed `lastSyncedSequence`,
    // so it accurately reflects the backlog at activation time.
    if (pendingCount.value > 0) {
      void push().catch(() => {
        // push() already records errors and schedules retries; swallow here
        // to avoid unhandled rejection at the activation site.
      })
    }
  }

  /** Deactivate sync. */
  function deactivate() {
    enabled.value = false
    target.value = null
    activeAdapter = null
    activeHost = null
    resetRetry()
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  /** Update sync pointer after WebRTC direct replay. */
  function updateLastSynced(seq: number) {
    if (seq > lastSyncedSequence.value) {
      lastSyncedSequence.value = seq
      persistCursor()
    }
  }

  /**
   * Restore the persisted sync cursor for the active map/branch.
   *
   * `lastSyncedSequence` was originally ephemeral - held only in the engine
   * singleton. After a fresh page load it started at 0, which caused:
   *   (a) every local commit to look "unsynced" on first push, provoking
   *       409s if the server already had them
   *   (b) `pendingCount` to report the full commit history as pending
   *   (c) the engine to re-sync commits that had long since been confirmed
   *
   * Callers (typically `useCollabWiring.activateForMap`) await this before
   * calling `activate(adapter, host)` so the first push carries the
   * correct baseSequence. If the load fails, the cursor stays at 0 - the
   * worst case is a single recoverable 409.
   */
  async function primeCursor(mapId: string, branchId: string): Promise<void> {
    try {
      const persisted = await loadSyncCursor(mapId, branchId)
      lastSyncedSequence.value = persisted
    } catch (e) {
      console.warn('[Sync] Could not load persisted sync cursor:', e)
    }
  }

  /** Internal: persist the current cursor for the active map/branch. Fire-and-forget. */
  function persistCursor(): void {
    const mapId = commitLog.mapId.value
    const branchId = commitLog.activeBranchId.value
    if (!mapId) return
    const seq = lastSyncedSequence.value
    void saveSyncCursor(mapId, branchId, seq).catch((e) => {
      console.warn('[Sync] Could not save sync cursor:', e)
    })
  }

  /**
   * Install or clear a push filter. The filter receives each candidate
   * commit and returns `true` to *exclude* it from the push.
   *
   * Used by `useCrossTab` so a tab does not push commits another tab on the
   * same device already pushed. Pass `null` to clear.
   */
  function setPushFilter(filter: PushFilter | null) {
    pushFilter = filter
  }

  /** Schedule a push after debounce. Called after commit append. */
  function schedulePush() {
    if (!enabled.value) return
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => push(), SYNC_DEBOUNCE_MS)
  }

  /** Push new local commits to the remote target. */
  async function push(): Promise<boolean> {
    if (!enabled.value || !activeAdapter) return false

    const mapId = commitLog.mapId.value
    const branchId = commitLog.activeBranchId.value
    if (!mapId) return false

    // Collect commits since last sync.
    //
    // `pushFilter` (set by useCrossTab) excludes commits this tab received
    // via BroadcastChannel from a sibling tab - those will be pushed by the
    // originating tab. Without the filter, two tabs on the same device would
    // double-push and create phantom conflicts.
    const allCommits = commitLog.commits.value
    const newCommits = allCommits.filter(
      c => c.sequence > lastSyncedSequence.value && (!pushFilter || !pushFilter(c)),
    )
    if (newCommits.length === 0) return true

    status.value = 'pushing'
    lastError.value = null

    try {
      const result = await activeAdapter.push(
        mapId,
        branchId,
        newCommits,
        lastSyncedSequence.value,
      )

      if (!result.success) {
        if (result.conflict) {
          status.value = 'conflict'
          lastErrorCategory.value = 'conflict'
          lastError.value = friendlySyncErrorMessage('conflict')
          if (!loggedErrorCategories.has('conflict')) {
            loggedErrorCategories.add('conflict')
            console.warn('[Sync] push conflict - pull required', { mapId, branchId })
          }
          return false
        }
        throw new Error(result.error || 'Push failed')
      }

      lastSyncedSequence.value = result.newHeadSequence
      lastSyncedAt.value = new Date().toISOString()
      status.value = 'idle'
      lastErrorCategory.value = null
      lastError.value = null
      resetRetry()
      persistCursor()
      return true
    } catch (e: any) {
      if (e?.statusCode === 409) {
        status.value = 'conflict'
        lastErrorCategory.value = 'conflict'
        lastError.value = friendlySyncErrorMessage('conflict')
        if (!loggedErrorCategories.has('conflict')) {
          loggedErrorCategories.add('conflict')
          console.warn('[Sync] push conflict - pull required', { mapId, branchId })
        }
        return false
      }
      status.value = 'error'
      recordSyncError('push', e, mapId, branchId)
      scheduleRetry(() => push())
      return false
    }
  }

  /** Pull new remote commits and merge if needed. */
  async function pull(): Promise<boolean> {
    if (!enabled.value || !activeAdapter || !activeHost) return false

    const mapId = commitLog.mapId.value
    const branchId = commitLog.activeBranchId.value
    if (!mapId) return false

    const host = activeHost
    status.value = 'pulling'
    lastError.value = null

    try {
      const result = await activeAdapter.pull(mapId, branchId, lastSyncedSequence.value)

      if (!result.success) {
        throw new Error(result.error || 'Pull failed')
      }

      if (result.commits.length === 0) {
        lastSyncedAt.value = new Date().toISOString()
        status.value = 'idle'
        resetRetry()
        return true
      }

      // Determine if we've diverged: local commits beyond last sync point?
      const localDeviceId = commitLog.getDeviceId()
      const localUnsynced = commitLog.commits.value.filter(
        c => c.sequence > lastSyncedSequence.value && c.deviceId === localDeviceId,
      )

      if (localUnsynced.length === 0) {
        // Fast-forward - replay remote commits in sequence order via the host
        const sorted = result.commits.sort((a, b) => a.sequence - b.sequence)
        host.applyFastForward(sorted)
        lastSyncedSequence.value = result.remoteHead
        lastSyncedAt.value = new Date().toISOString()
        status.value = 'idle'
        resetRetry()
        persistCursor()
        return true
      } else {
        // Diverged - model-only three-way merge

        // 1. Compute merge base from checkpoint
        const checkpoint = commitLog.latestCheckpoint.value
        if (!checkpoint) {
          status.value = 'error'
          lastError.value = 'No checkpoint available for merge base'
          return false
        }

        // Replay from checkpoint to lastSyncedSequence to get base state.
        const commitsToBase = commitLog.commits.value.filter(
          c => c.sequence > checkpoint.sequence && c.sequence <= lastSyncedSequence.value,
        )
        const baseState = commitLog.replayCommits(checkpoint, commitsToBase)

        // 2. Replay remote commits from base to get "theirs"
        const theirsCheckpoint: Checkpoint = {
          id: 'merge-base',
          mapId: commitLog.mapId.value,
          commitId: 'merge-base',
          sequence: lastSyncedSequence.value,
          branchId: commitLog.activeBranchId.value,
          model: baseState.model,
          timestamp: new Date().toISOString(),
        }
        const sortedRemote = result.commits.sort((a, b) => a.sequence - b.sequence)
        const theirsState = commitLog.replayCommits(theirsCheckpoint, sortedRemote)

        // 3. Current local state is "ours" - merge (model-only)
        const mergeResult = threeWayMerge({
          base: baseState.model,
          ours: host.getRoot(),
          theirs: theirsState.model,
        })

        if (mergeResult.success) {
          // Clean merge - install via host and push
          host.applyMerged(mergeResult.mergedModel)
          lastSyncedSequence.value = result.remoteHead
          lastSyncedAt.value = new Date().toISOString()
          status.value = 'idle'
          resetRetry()
          persistCursor()
          await push()
          return true
        } else {
          // Conflicts - surface via host callback
          host.onConflict(mergeResult)
          status.value = 'conflict'
          return false
        }
      }
    } catch (e: any) {
      status.value = 'error'
      recordSyncError('pull', e, mapId, branchId)
      scheduleRetry(() => pull())
      return false
    }
  }

  /** Full sync cycle: pull then push. */
  async function sync(): Promise<boolean> {
    resetRetry()
    const pulled = await pull()
    if (!pulled) return false
    return push()
  }

  /**
   * User-initiated sync recovery. Called from the branch manager dropdown
   * when the engine is in `error` or `conflict` state. Clears the retry
   * backoff, re-primes the cursor from IDB (in case navigation or another
   * tab moved it), and runs a full sync cycle. Returns true on success.
   */
  async function retryNow(): Promise<boolean> {
    resetRetry()
    status.value = 'idle'
    const mapId = commitLog.mapId.value
    const branchId = commitLog.activeBranchId.value
    if (mapId) await primeCursor(mapId, branchId)
    return sync()
  }

  return {
    status: readonly(status),
    lastSyncedSequence: readonly(lastSyncedSequence),
    lastSyncedAt: readonly(lastSyncedAt),
    lastError: readonly(lastError),
    lastErrorCategory: readonly(lastErrorCategory),
    enabled: readonly(enabled),
    target: readonly(target),
    pendingCount,
    activate,
    deactivate,
    updateLastSynced,
    setPushFilter,
    primeCursor,
    retryNow,
    schedulePush,
    push,
    pull,
    sync,
  }
}

// ── Test-only: reset singleton state ────────────────────────────────────────

export function resetSyncEngineSingleton(): void {
  status.value = 'idle'
  lastSyncedSequence.value = 0
  lastSyncedAt.value = null
  lastError.value = null
  lastErrorCategory.value = null
  enabled.value = false
  target.value = null
  activeAdapter = null
  activeHost = null
  pushFilter = null
  loggedErrorCategories.clear()
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  retryCount = 0
}
