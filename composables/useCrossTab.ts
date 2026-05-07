import { ref, readonly } from 'vue'
import { nanoid } from 'nanoid'
import type { Commit } from '@businessmaps/metaontology/types/commits'
import { useCommitLog } from './useCommitLog'
import { useSyncEngine } from './useSyncEngine'

// ── Per-tab identity ────────────────────────────────────────────────────────
//
// `tabId` is unique per JavaScript context - i.e., per browser tab. It is
// generated once when this module is first imported and never changes for the
// life of the tab. This is the loop-prevention discriminator on cross-tab
// broadcast envelopes.
//
// Important: this is NOT the same as `useCommitLog().getDeviceId()`. `deviceId`
// is per-DEVICE (read from IDB config) and is shared across tabs of the same
// browser. Sync uses `deviceId` for cloud-sync echo detection, where peers are
// distinct devices. Cross-tab sees both tabs as the same device, so it needs
// its own per-tab identifier.
//

const tabId = nanoid()

// ── Module-level singleton ──────────────────────────────────────────────────
//
// One `useCrossTab` per tab. The composable owns at most one `BroadcastChannel`
// at a time - opened in `activate(mapId, host)`, closed in `deactivate()`.
// Switching maps deactivates the previous channel and opens a new one.

const enabled = ref(false)
const activeMapId = ref<string | null>(null)

let channel: BroadcastChannel | null = null
let activeHost: CrossTabHost | null = null
let unbindAppendListener: (() => void) | null = null

/**
 * IDs of commits this tab received from a sibling tab via the broadcast
 * channel. The sync engine consults this set when deciding whether to push a
 * commit to remote: if a commit was received cross-tab, the originating tab
 * is responsible for pushing it, and this tab must NOT re-push.
 *
 * The set grows for the life of the activated channel and is cleared on
 * deactivate. In normal operation it stays small (commits flow through and
 * out as the originating tab pushes them); growth is bounded by the
 * checkpoint interval - old commits become checkpoint state and are no
 * longer push candidates.
 */
const crossTabReceivedIds = new Set<string>()

// ── Host: app-side coupling via dependency injection ───────────────────────
//
// Mirrors the `SyncHost` pattern from `useSyncEngine.ts`. The cross-tab
// composable cannot import from the consuming app's code. The consuming app's
// store implements this interface and passes an instance to
// `activate(mapId, host)`. When a commit arrives from another tab, the
// composable calls `host.applyRemoteCommit(commit)` - the same path the
// consuming app uses for WebRTC peer commits.

export interface CrossTabHost {
  /**
   * Apply a commit received from another tab on the same device.
   *
   * The host MUST:
   *  - Apply the command to the model
   *  - Append the commit to `commitLog.commits.value` (via the existing
   *    `replayRemoteCommit` path)
   *  - NOT call `appendCommit` (which would re-broadcast and re-push)
   *  - NOT add to the local undo/redo stack
   */
  applyRemoteCommit(commit: Commit): void
}

// ── Wire envelope ──────────────────────────────────────────────────────────

interface CrossTabMessage {
  type: 'commit'
  /** The originating tab's `tabId`. Used by receivers to skip echoes. */
  fromTabId: string
  commit: Commit
}

// ── Composable ─────────────────────────────────────────────────────────────

export function useCrossTab() {
  return {
    enabled: readonly(enabled),
    activeMapId: readonly(activeMapId),
    /** The per-tab identifier. Stable for the life of this tab. */
    getTabId,
    activate,
    deactivate,
    /**
     * True if the named commit was received via cross-tab broadcast (i.e., it
     * originated on a sibling tab on this device). The sync engine uses this
     * to skip pushing commits that another tab will push.
     */
    wasReceivedFromAnotherTab,
  }
}

function getTabId(): string {
  return tabId
}

function wasReceivedFromAnotherTab(commitId: string): boolean {
  return crossTabReceivedIds.has(commitId)
}

/**
 * Activate cross-tab broadcast for a map.
 *
 * Opens a `BroadcastChannel` named `bm-crosstab-${mapId}`, registers a hook
 * on `useCommitLog` so newly-appended local commits are broadcast, and
 * installs a push filter on `useSyncEngine` so commits received from sibling
 * tabs are not pushed twice.
 *
 * Calling `activate()` while already active for a different mapId
 * deactivates the previous channel first.
 */
function activate(mapId: string, host: CrossTabHost): void {
  if (enabled.value && activeMapId.value === mapId) return
  if (enabled.value) deactivate()

  // BroadcastChannel may not exist in non-browser test runners. Treat its
  // absence as "cross-tab disabled" rather than throwing - the tab still
  // works in single-tab mode.
  if (typeof BroadcastChannel === 'undefined') {
    console.warn('[useCrossTab] BroadcastChannel not available - cross-tab disabled')
    return
  }

  channel = new BroadcastChannel(`bm-crosstab-${mapId}`)
  activeHost = host
  activeMapId.value = mapId
  enabled.value = true
  crossTabReceivedIds.clear()

  channel.addEventListener('message', handleMessage)

  // Subscribe to local commit appends - broadcast each one.
  const commitLog = useCommitLog()
  unbindAppendListener = commitLog.onAppend((commit) => {
    publishCommit(commit)
  })

  // Install the sync engine push filter so commits received cross-tab are
  // not re-pushed by this tab.
  const sync = useSyncEngine()
  sync.setPushFilter(commit => crossTabReceivedIds.has(commit.id))
}

/** Tear down the channel and unregister hooks. */
function deactivate(): void {
  if (!enabled.value) return

  if (unbindAppendListener) {
    unbindAppendListener()
    unbindAppendListener = null
  }

  // Clear the sync engine push filter.
  const sync = useSyncEngine()
  sync.setPushFilter(null)

  if (channel) {
    channel.removeEventListener('message', handleMessage)
    channel.close()
    channel = null
  }

  activeHost = null
  activeMapId.value = null
  enabled.value = false
  crossTabReceivedIds.clear()
}

/** Broadcast a locally-appended commit to sibling tabs. */
function publishCommit(commit: Commit): void {
  if (!channel) return
  // Only broadcast commits whose mapId matches the active channel. The
  // commit log can be reused across maps; the channel is per-map.
  if (commit.mapId !== activeMapId.value) return

  const message: CrossTabMessage = {
    type: 'commit',
    fromTabId: tabId,
    commit,
  }
  try {
    channel.postMessage(message)
  } catch (e) {
    console.warn('[useCrossTab] postMessage failed:', e)
  }
}

function handleMessage(event: MessageEvent<CrossTabMessage>): void {
  const msg = event.data
  if (!msg || msg.type !== 'commit') return

  // Echo prevention: skip our own broadcasts.
  if (msg.fromTabId === tabId) return

  // Map mismatch: BroadcastChannel scoping should prevent this, but defend
  // against the channel being shared by mistake.
  if (msg.commit.mapId !== activeMapId.value) return

  // Idempotent receive: if this tab has already seen this commit id, drop
  // the duplicate. BroadcastChannel ordinarily delivers each message once,
  // but redelivery can happen during channel re-attachment, multi-window
  // edge cases, or test fixtures that post directly.
  if (crossTabReceivedIds.has(msg.commit.id)) return

  // Mark this commit as "received from another tab" before delivering it to
  // the host. The host will append it to `commitLog.commits.value`; the sync
  // engine will then consult `crossTabReceivedIds` and skip pushing it.
  crossTabReceivedIds.add(msg.commit.id)

  if (activeHost) {
    try {
      activeHost.applyRemoteCommit(msg.commit)
    } catch (e) {
      console.error('[useCrossTab] host.applyRemoteCommit failed:', e)
      // The commit landed in `crossTabReceivedIds` regardless. The sync
      // engine will still skip it. The local state is just out of sync -
      // the next pull from cloud (if any) will reconcile.
    }
  }
}

// ── Test-only: reset singleton state ───────────────────────────────────────

export function resetCrossTabSingleton(): void {
  if (channel) {
    channel.removeEventListener('message', handleMessage)
    channel.close()
    channel = null
  }
  if (unbindAppendListener) {
    unbindAppendListener()
    unbindAppendListener = null
  }
  activeHost = null
  activeMapId.value = null
  enabled.value = false
  crossTabReceivedIds.clear()
}
