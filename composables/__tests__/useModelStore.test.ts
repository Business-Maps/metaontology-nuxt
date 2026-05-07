/**
 * Tests for `useModelStore`  - the ontology layer's typed public API for
 * model-tier persistence.
 *
 * useModelStore wraps `useCommitLog` with a model-only surface:
 *   - loadModel(mapId): load a model from storage
 *   - saveModel(model): create a genesis checkpoint for a new model
 *   - listMaps(): list all map ids that have persisted state
 *   - deleteMap(mapId): delete a map's commits, checkpoints, and heads
 *
 * This file covers the minimum viable contract. Richer behavior (branch
 * switching, sync integration, overlay management) lands in future phases.
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useModelStore, resetModelStoreSingleton } from '../useModelStore'
import { createEmptyRootContext } from '@businessmaps/metaontology/engine/apply'
import { resetIdb } from '../../__tests__/helpers/resetIdb'

beforeEach(async () => {
  await resetIdb()
  resetModelStoreSingleton()
})

afterEach(async () => {
  resetModelStoreSingleton()
})

describe('useModelStore  - singleton', () => {
  it('returns the same instance across calls', () => {
    const a = useModelStore()
    const b = useModelStore()
    expect(a).toBe(b)
  })

  it('resetModelStoreSingleton produces a fresh instance', () => {
    const a = useModelStore()
    resetModelStoreSingleton()
    const b = useModelStore()
    expect(a).not.toBe(b)
  })
})

describe('useModelStore  - initial state', () => {
  it('starts with no model loaded', () => {
    const store = useModelStore()
    expect(store.root.value).toBeNull()
    expect(store.isLoaded.value).toBe(false)
    expect(store.loading.value).toBe(false)
    expect(store.error.value).toBeNull()
  })
})

describe('useModelStore  - saveModel + loadModel round-trip', () => {
  it('saves a new model and loads it back', async () => {
    const store = useModelStore()
    const model = createEmptyRootContext('Round Trip')

    await store.saveModel(model)

    // After save, the store's root is populated
    expect(store.root.value).not.toBeNull()
    expect(store.root.value!.uri).toBe(model.uri)
    expect(store.isLoaded.value).toBe(true)

    // Reset and reload from IDB
    store.reset()
    expect(store.isLoaded.value).toBe(false)

    const loaded = await store.loadModel(model.uri)
    expect(loaded).not.toBeNull()
    expect(loaded!.uri).toBe(model.uri)
    expect(loaded!.name).toBe('Round Trip')
    expect(store.root.value!.uri).toBe(model.uri)
  })

  it('loadModel returns null when the map does not exist', async () => {
    const store = useModelStore()
    const result = await store.loadModel('nonexistent')
    expect(result).toBeNull()
    expect(store.root.value).toBeNull()
  })
})

describe('useModelStore  - listMaps', () => {
  it('returns empty when no maps exist', async () => {
    const store = useModelStore()
    const maps = await store.listMaps()
    expect(maps).toEqual([])
  })

  it('lists maps that have been saved', async () => {
    const store = useModelStore()
    const m1 = createEmptyRootContext('Map One')
    await store.saveModel(m1)

    // Save a second map (reset the singleton between saves so the commit
    // log starts fresh  - otherwise saveModel complains about reinitializing)
    resetModelStoreSingleton()
    const store2 = useModelStore()
    const m2 = createEmptyRootContext('Map Two')
    await store2.saveModel(m2)

    const maps = await store2.listMaps()
    expect(maps.sort()).toEqual([m1.uri, m2.uri].sort())
  })
})

describe('useModelStore  - deleteMap', () => {
  it('removes a map from the listMaps result', async () => {
    const store = useModelStore()
    const m1 = createEmptyRootContext('Delete Me')
    await store.saveModel(m1)

    let maps = await store.listMaps()
    expect(maps).toContain(m1.uri)

    await store.deleteMap(m1.uri)

    maps = await store.listMaps()
    expect(maps).not.toContain(m1.uri)
  })

  it('clears local state when the currently-loaded map is deleted', async () => {
    const store = useModelStore()
    const m1 = createEmptyRootContext('Delete Current')
    await store.saveModel(m1)

    expect(store.isLoaded.value).toBe(true)

    await store.deleteMap(m1.uri)

    expect(store.root.value).toBeNull()
    expect(store.isLoaded.value).toBe(false)
  })
})
