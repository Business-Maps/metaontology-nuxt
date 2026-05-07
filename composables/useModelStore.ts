import { ref, computed, type Ref } from 'vue'
import { useCommitLog } from './useCommitLog'
import { getDb } from './idbConnection'
import type { RootContext } from '@businessmaps/metaontology/types/context'
import type { Commit, Checkpoint } from '@businessmaps/metaontology/types/commits'

// ── useModelStore ────────────────────────────────────────────────────────
//
// The layer's model persistence surface. Wraps `useCommitLog` with
// load / save / list / delete operations. Intended for headless
// consumers (scripts, migrations, generated businesses). The consuming
// app typically wraps this with its own store surface for domain-specific
// operations.

let _singleton: ReturnType<typeof createModelStore> | null = null

/**
 * Singleton accessor. Returns the same store instance across calls so
 * consumers in the same Vue app share state.
 */
export function useModelStore() {
  if (!_singleton) _singleton = createModelStore()
  return _singleton
}

/** Test-only: reset the singleton between test runs. */
export function resetModelStoreSingleton(): void {
  _singleton = null
}

function createModelStore() {
  const commitLog = useCommitLog()

  // Reactive view of the current map's model. Set on load/init,
  // mutated implicitly by commits dispatched through the engine.
  const root = ref<RootContext | null>(null) as Ref<RootContext | null>
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isLoaded = computed(() => root.value !== null)
  const currentMapId = computed(() => commitLog.mapId.value)
  const currentBranchId = computed(() => commitLog.activeBranchId.value)

  /**
   * Load a map's model from storage. Replays commits since the latest
   * checkpoint, runs migration on the loaded checkpoint (model-only -
   * layout is discarded if present).
   */
  async function loadModel(mapId: string, branchId: string = 'main'): Promise<RootContext | null> {
    loading.value = true
    error.value = null
    try {
      const result = await commitLog.loadFromStorage(mapId, branchId)
      if (!result) {
        root.value = null
        return null
      }
      root.value = result.model
      return result.model
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  /**
   * Initialize a new model with a genesis checkpoint. The map id should
   * already match the model's `id`.
   */
  async function saveModel(model: RootContext): Promise<void> {
    await commitLog.initFromSnapshot(model.uri, model)
    root.value = model
  }

  /**
   * List the map ids that have any persisted state in IDB. Drains the
   * `heads` store, which holds one row per (map, branch) pair.
   */
  async function listMaps(): Promise<string[]> {
    const db = await getDb()
    const allHeads = await db.getAll('heads')
    const ids = new Set<string>()
    for (const head of allHeads) {
      ids.add(head.mapId)
    }
    return Array.from(ids)
  }

  /**
   * Delete a map's commits, checkpoints, and branch heads from IDB.
   * Does not touch legacy `documents` / `branches` stores - the consuming
   * app is responsible for cleaning those up alongside this call.
   */
  async function deleteMap(mapId: string): Promise<void> {
    const db = await getDb()

    // Delete all commits for this map across all branches
    const commitsTx = db.transaction('commits', 'readwrite')
    const commitsIndex = commitsTx.store.index('by-map-branch-seq')
    const commitsRange = IDBKeyRange.bound(
      [mapId, '', 0],
      [mapId, '\uffff', Number.MAX_SAFE_INTEGER],
    )
    let cursor = await commitsIndex.openCursor(commitsRange)
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }
    await commitsTx.done

    // Delete all checkpoints for this map across all branches
    const cpTx = db.transaction('checkpoints', 'readwrite')
    const cpIndex = cpTx.store.index('by-map-branch-seq')
    const cpRange = IDBKeyRange.bound(
      [mapId, '', 0],
      [mapId, '\uffff', Number.MAX_SAFE_INTEGER],
    )
    let cpCursor = await cpIndex.openCursor(cpRange)
    while (cpCursor) {
      await cpCursor.delete()
      cpCursor = await cpCursor.continue()
    }
    await cpTx.done

    // Delete all branch heads for this map
    const headsTx = db.transaction('heads', 'readwrite')
    const allHeads = await headsTx.store.getAll()
    for (const head of allHeads) {
      if (head.mapId === mapId) {
        await headsTx.store.delete([head.mapId, head.branchId])
      }
    }
    await headsTx.done

    // If we just deleted the currently-loaded map, clear local state
    if (commitLog.mapId.value === mapId) {
      commitLog.reset()
      root.value = null
    }
  }

  /** Test-only: reset all in-memory state. */
  function reset(): void {
    commitLog.reset()
    root.value = null
    loading.value = false
    error.value = null
  }

  return {
    // Reactive state
    root,
    loading,
    error,
    isLoaded,
    currentMapId,
    currentBranchId,

    // Operations
    loadModel,
    saveModel,
    listMaps,
    deleteMap,
    reset,

    // Underlying commit log (for advanced consumers - sync, branches, etc.)
    commitLog,
  }
}

// Re-export types for consumers
export type { RootContext, Commit, Checkpoint }
