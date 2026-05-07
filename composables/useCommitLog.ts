import { ref, computed, toRaw } from 'vue'
import { nanoid } from 'nanoid'
import { useDebounceFn } from '@vueuse/core'
import { applyCommand, applyBatch } from '@businessmaps/metaontology/engine/apply'
import { applyM0Command } from '@businessmaps/metaontology/engine/applyM0'
import { migrateModel } from '@businessmaps/metaontology/migrations'
import type { RootContext } from '@businessmaps/metaontology/types/context'
import type { DispatchableCommand, Command, M0Command, BatchCommand } from '@businessmaps/metaontology/types/commands'
import { isM0Command } from '@businessmaps/metaontology/types/commands'
import { createEmptyM0State } from '@businessmaps/metaontology/types/m0'
import type { M0State } from '@businessmaps/metaontology/types/m0'
import type { Commit, Checkpoint, UndoEntry } from '@businessmaps/metaontology/types/commits'
import type { IDBCommitRecord, IDBCheckpointRecord } from './idbSchema'
import {
  saveCommits,
  loadCommitsSince,
  saveCheckpoint as idbSaveCheckpoint,
  loadLatestCheckpoint,
  pruneOldCheckpoints,
  saveBranchHead,
} from './idbHelpers'

const CHECKPOINT_INTERVAL = 100
const MAX_UNDO = 50

// Hard cap on how many commits may sit in the pending-flush buffer before we
// bypass the debounce and write immediately. The original debounce model
// waited 800ms from the last append - fine for a human typing one command at
// a time, catastrophic when the AI rapid-fires 200 tool calls in 10 seconds
// because the debouncer never fires (each append resets it). With 25 commits
// in the buffer we force a write so nothing builds up beyond a single IDB
// transaction's worth, and a page unload loses at most 24 commits instead of
// the whole run.
const PENDING_FLUSH_CAP = 25

// ── Module-level singleton ────────────────────────────────────────────────
//
// `useCommitLog` returns a shared singleton per JavaScript context (per browser
// tab). Multiple call sites (store, sync engine, collab wiring, UI components)
// all see the same state. Cross-tab isolation comes from the JavaScript module
// being loaded separately in each tab, not from per-call factoring.
//
// This is a singleton because the per-call factory pattern left sync, echo
// detection, and other cross-composable consumers reading from blank state.

let _singleton: ReturnType<typeof createCommitLog> | null = null

export function useCommitLog() {
  if (!_singleton) _singleton = createCommitLog()
  return _singleton
}

/** Test-only: reset the singleton between test runs. */
export function resetCommitLogSingleton(): void {
  _singleton = null
}

function createCommitLog() {
  // ── In-memory commit state ────────────────────────────────────────────
  const mapId = ref<string>('')
  const activeBranchId = ref<string>('main')
  const commits = ref<Commit[]>([])
  const latestCheckpoint = ref<Checkpoint | null>(null)
  const nextSequence = ref(0)
  const headCommitId = ref<string | null>(null)
  const active = ref(false)

  // Commits that haven't been flushed to IDB yet
  const pendingCommits = ref<Commit[]>([])

  // ── Undo/redo session state ───────────────────────────────────────────
  const undoStack = ref<UndoEntry[]>([])
  const redoStack = ref<UndoEntry[]>([])

  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  // ── Device ID (lazy - filled by the store on init) ────────────────────
  let deviceId = 'local'

  function setDeviceId(id: string) {
    deviceId = id
  }

  function getDeviceId(): string {
    return deviceId
  }

  // ── Append listeners ──────────────────────────────────────────────────
  //
  // Sibling composables (cross-tab broadcast, awareness, telemetry) can
  // subscribe to the moment a commit is appended. The listener fires
  // synchronously after the commit lands in `commits.value` and before
  // the debounced flush schedules. Listener errors are caught so a
  // misbehaving subscriber cannot break the dispatch path.
  //
  // (Added for cross-tab broadcast support via `useCrossTab`.)
  type AppendListener = (commit: Commit) => void
  const appendListeners = new Set<AppendListener>()

  function onAppend(listener: AppendListener): () => void {
    appendListeners.add(listener)
    return () => appendListeners.delete(listener)
  }

  // ── Core operations ───────────────────────────────────────────────────

  function appendCommit(
    command: DispatchableCommand,
    inverse: DispatchableCommand,
  ): Commit {
    const commit: Commit = {
      id: nanoid(),
      mapId: mapId.value,
      sequence: nextSequence.value++,
      command,
      inverse,
      timestamp: new Date().toISOString(),
      deviceId,
      branchId: activeBranchId.value,
      parentId: headCommitId.value,
    }

    commits.value.push(commit)
    pendingCommits.value.push(commit)
    headCommitId.value = commit.id

    // Track for session undo (clear redo on new commit)
    undoStack.value.push({
      commitId: commit.id,
      originalCommand: command,
      inverseCommand: inverse,
    })
    if (undoStack.value.length > MAX_UNDO) undoStack.value.shift()
    redoStack.value = []

    // Maybe checkpoint
    if (nextSequence.value % CHECKPOINT_INTERVAL === 0) {
      scheduleCheckpoint()
    }

    // Notify subscribers (cross-tab broadcast, etc.). Catch listener errors
    // so a buggy subscriber cannot break dispatch.
    for (const listener of appendListeners) {
      try {
        listener(commit)
      } catch (e) {
        console.warn('[useCommitLog] append listener failed:', e)
      }
    }

    // If the pending buffer has grown past the cap, bypass the debounce
    // and write immediately. This prevents debounce starvation during rapid
    // AI dispatches (see PENDING_FLUSH_CAP). Fire-and-forget: we do not
    // await here because `appendCommit` is synchronous for its callers.
    if (pendingCommits.value.length >= PENDING_FLUSH_CAP) {
      void flushPendingNow().catch((e) => {
        console.warn('[useCommitLog] cap-triggered flush failed:', e)
      })
    } else {
      scheduleFlush()
    }
    return commit
  }

  /** Returns the inverse command to dispatch for undo, or null if nothing to undo. */
  function popUndo(): UndoEntry | null {
    const entry = undoStack.value.pop()
    if (!entry) return null
    redoStack.value.push(entry)
    return entry
  }

  /** Returns the original command to re-dispatch for redo, or null if nothing to redo. */
  function popRedo(): UndoEntry | null {
    const entry = redoStack.value.pop()
    if (!entry) return null
    // Don't push back to undoStack here - the store will call appendCommit
    // for the redo dispatch, which pushes a new entry to undoStack
    return entry
  }

  // ── Replay: derive state from checkpoint + commits ────────────────────

  /**
   * Pure replay: project commands onto the checkpoint's state.
   *
   * Pure domain replay - no layout routing. Every command is applied
   * via `applyCommand` or `applyBatch`. Returns `failures`: the number
   * of commits whose apply step failed validation. Loaders use this to
   * detect pre-existing broken commit logs and trigger a self-heal
   * checkpoint - see `loadFromStorage` for the wiring.
   */
  function replayCommits(
    checkpoint: Checkpoint,
    replayable: Commit[],
    commandFilter?: (cmd: DispatchableCommand) => boolean,
  ): { model: RootContext; m0: M0State; failures: number } {
    let model = checkpoint.model
    let m0 = checkpoint.m0 ?? createEmptyM0State()
    let failures = 0

    for (const commit of replayable) {
      const cmd = commit.command
      if (commandFilter && !commandFilter(cmd)) continue

      if (cmd.type === 'batch') {
        const subCommands = commandFilter
          ? cmd.payload.commands.filter(commandFilter)
          : cmd.payload.commands
        // Split M0 and M1 commands in the batch
        const m1Commands = subCommands.filter(c => !isM0Command(c))
        const m0Commands = subCommands.filter(c => isM0Command(c)) as M0Command[]
        // Apply M1 batch first (model may update for cross-tier validation)
        if (m1Commands.length > 0) {
          const batch: BatchCommand = { type: 'batch', payload: { commands: m1Commands, label: cmd.payload.label } }
          const result = applyBatch(model, batch)
          if (result.success) {
            model = result.state
          } else {
            failures++
            console.warn(
              `[replayCommits] batch commit ${commit.id} (seq ${commit.sequence}) failed: ${result.error}`,
              { commit, sub: m1Commands.map(c => c.type) },
            )
          }
        }
        // Then apply M0 commands sequentially (using updated model for validation)
        for (const m0cmd of m0Commands) {
          const result = applyM0Command(m0, m0cmd, model)
          if (result.success) {
            m0 = result.state
          } else {
            failures++
            console.warn(
              `[replayCommits] M0 command in batch ${commit.id} (${m0cmd.type}) failed: ${result.error}`,
            )
          }
        }
      } else if (isM0Command(cmd)) {
        // Standalone M0 command
        const result = applyM0Command(m0, cmd, model)
        if (result.success) {
          m0 = result.state
        } else {
          failures++
          console.warn(
            `[replayCommits] M0 commit ${commit.id} (seq ${commit.sequence}, ${cmd.type}) failed: ${result.error}`,
            { commit },
          )
        }
      } else {
        const result = applyCommand(model, cmd as Command)
        if (result.success) {
          model = result.state
        } else {
          failures++
          console.warn(
            `[replayCommits] commit ${commit.id} (seq ${commit.sequence}, ${cmd.type}) failed: ${result.error}`,
            { commit },
          )
        }
      }
    }

    return { model, m0, failures }
  }

  // ── Load from IDB ─────────────────────────────────────────────────────

  async function loadFromStorage(
    loadMapId: string,
    branchId: string = 'main',
  ): Promise<{ model: RootContext; m0: M0State; replayFailures: number } | null> {
    const checkpoint = await loadLatestCheckpoint(loadMapId, branchId)
    if (!checkpoint) return null

    // Migrate legacy checkpoints to the current schema version. This is a
    // one-shot policy applied as the checkpoint enters the system; replay
    // itself stays pure.
    migrateModel(checkpoint.model)

    const sinceSeq = checkpoint.sequence
    const storedCommits = await loadCommitsSince(loadMapId, branchId, sinceSeq)

    // Convert IDB records to Commit objects
    const replayable: Commit[] = storedCommits.map(r => ({
      id: r.id,
      mapId: r.mapId,
      sequence: r.sequence,
      command: r.command,
      inverse: r.inverse,
      timestamp: r.timestamp,
      deviceId: r.deviceId,
      branchId: r.branchId,
      parentId: r.parentId,
    }))

    const cp: Checkpoint = {
      id: checkpoint.id,
      mapId: checkpoint.mapId,
      commitId: checkpoint.commitId,
      sequence: checkpoint.sequence,
      branchId: checkpoint.branchId,
      model: checkpoint.model,
      m0: checkpoint.m0,
      timestamp: checkpoint.timestamp,
    }

    const state = replayCommits(cp, replayable)

    // Set internal state
    mapId.value = loadMapId
    activeBranchId.value = branchId
    latestCheckpoint.value = cp
    commits.value = replayable
    nextSequence.value = replayable.length > 0
      ? replayable[replayable.length - 1]!.sequence + 1
      : cp.sequence + 1
    headCommitId.value = replayable.length > 0
      ? replayable[replayable.length - 1]!.id
      : cp.commitId
    pendingCommits.value = []
    undoStack.value = []
    redoStack.value = []
    active.value = true

    return { model: state.model, m0: state.m0, replayFailures: state.failures }
  }

  /**
   * Initialize from an existing snapshot (for migration or fresh create).
   * Creates a genesis checkpoint with no prior commits.
   */
  async function initFromSnapshot(
    initMapId: string,
    model: RootContext,
  ): Promise<void> {
    const genesisId = 'genesis'
    const cp: Checkpoint = {
      id: nanoid(),
      mapId: initMapId,
      commitId: genesisId,
      sequence: 0,
      branchId: 'main',
      model: structuredClone(toRaw(model)),
      timestamp: new Date().toISOString(),
    }

    await idbSaveCheckpoint(cp as IDBCheckpointRecord)
    await saveBranchHead({
      mapId: initMapId,
      branchId: 'main',
      name: 'main',
      headCommitId: genesisId,
      forkPointCommitId: genesisId,
      parentBranchId: '',
      createdAt: cp.timestamp,
    })

    mapId.value = initMapId
    activeBranchId.value = 'main'
    latestCheckpoint.value = cp
    commits.value = []
    nextSequence.value = 1
    headCommitId.value = genesisId
    pendingCommits.value = []
    undoStack.value = []
    redoStack.value = []
    active.value = true
  }

  // ── Persistence ───────────────────────────────────────────────────────
  //
  // Two flush paths: a debounced one that fires ~800ms after the last
  // append (good for normal human editing) and an immediate path used when
  // `PENDING_FLUSH_CAP` is exceeded or the page is about to unload. Both
  // funnel through `flushPendingNow()` which does the actual IDB write.

  async function flushPendingNow(): Promise<void> {
    if (!active.value || pendingCommits.value.length === 0) return
    const toFlush = [...pendingCommits.value]
    pendingCommits.value = []
    await saveCommits(toFlush.map(c => JSON.parse(JSON.stringify(toRaw(c))) as IDBCommitRecord))

    // Update branch head
    const lastCommit = toFlush[toFlush.length - 1]!
    await saveBranchHead({
      mapId: mapId.value,
      branchId: activeBranchId.value,
      name: activeBranchId.value === 'main' ? 'main' : activeBranchId.value,
      headCommitId: lastCommit.id,
      forkPointCommitId: latestCheckpoint.value?.commitId ?? 'genesis',
      parentBranchId: '',
      createdAt: latestCheckpoint.value?.timestamp ?? new Date().toISOString(),
    })
  }

  const scheduleFlush = useDebounceFn(flushPendingNow, 800)

  let _getRoot: (() => RootContext) | null = null
  let _getM0: (() => M0State) | null = null

  function bindStateAccessors(
    getRoot: () => RootContext,
    getM0?: () => M0State,
  ) {
    _getRoot = getRoot
    if (getM0) _getM0 = getM0
  }

  const scheduleCheckpoint = useDebounceFn(async () => {
    if (!active.value || !_getRoot) return
    await createCheckpointNow()
  }, 100) // Short debounce - checkpoint is infrequent but should be fast

  async function createCheckpointNow(): Promise<void> {
    if (!_getRoot || !headCommitId.value) return

    const cp: Checkpoint = {
      id: nanoid(),
      mapId: mapId.value,
      commitId: headCommitId.value,
      sequence: nextSequence.value - 1,
      branchId: activeBranchId.value,
      model: structuredClone(toRaw(_getRoot())),
      m0: _getM0 ? structuredClone(toRaw(_getM0())) : undefined,
      timestamp: new Date().toISOString(),
    }

    await idbSaveCheckpoint(cp as IDBCheckpointRecord)
    latestCheckpoint.value = cp

    // Prune old checkpoints - keep latest 3
    await pruneOldCheckpoints(mapId.value, activeBranchId.value, 3)
  }

  async function forceFlush(): Promise<void> {
    await flushPendingNow()
    await createCheckpointNow()
  }

  // ── Unload handlers ───────────────────────────────────────────────────
  //
  // When the page is about to unload - tab close, navigation, visibility
  // hidden - we fire-and-forget a flush so pending commits reach IDB before
  // the process terminates. Browsers give unload handlers ~10-100ms to
  // complete async work; for a small IDB transaction that's enough.
  //
  // Three signals are wired because each catches a different case:
  //  - `visibilitychange` (hidden): most reliable on mobile; fires when
  //    user backgrounds the tab or navigates away inside the browser
  //  - `pagehide`: fires on actual page unload including back/forward cache
  //    enter on iOS
  //  - `beforeunload`: legacy desktop path for window close and navigation
  //
  // Installed once per singleton. `reset()` does not uninstall because the
  // singleton survives across map switches - the handlers are fine to keep.

  function handleUnloadSignal() {
    if (!active.value) return
    if (pendingCommits.value.length === 0) return
    // Fire and forget. The IDB transaction is started synchronously; the
    // browser typically lets it complete before tearing down the page.
    void flushPendingNow().catch(() => {
      // Swallow - we're in an unload path, there's nowhere to surface this.
    })
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') handleUnloadSignal()
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', handleUnloadSignal)
    window.addEventListener('beforeunload', handleUnloadSignal)
  }

  // ── Reset ─────────────────────────────────────────────────────────────

  function reset() {
    mapId.value = ''
    activeBranchId.value = 'main'
    commits.value = []
    latestCheckpoint.value = null
    nextSequence.value = 0
    headCommitId.value = null
    pendingCommits.value = []
    undoStack.value = []
    redoStack.value = []
    active.value = false
  }

  return {
    mapId,
    activeBranchId,
    commits,
    latestCheckpoint,
    headCommitId,
    active,
    canUndo,
    canRedo,
    undoStack,
    setDeviceId,
    getDeviceId,
    onAppend,
    flushPending: flushPendingNow,
    nextSequence,
    appendCommit,
    popUndo,
    popRedo,
    replayCommits,
    loadFromStorage,
    initFromSnapshot,
    bindStateAccessors,
    createCheckpointNow,
    forceFlush,
    reset,
  }
}
