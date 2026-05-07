/**
 * Acceptance tests for `useCommitLog` optional-layout and commandFilter contracts.
 *
 * Contract changes:
 *   1. `Checkpoint.layout` becomes optional. A checkpoint without a layout
 *      can still be loaded and replayed; the result has `layout: undefined`.
 *   2. `replayCommits()` accepts an optional `commandFilter: (cmd) => boolean`
 *      so a layer that doesn't know about layout can replay model-only
 *      commits. When `commandFilter` is omitted, behavior is identical to
 *      today.
 *   3. `replayCommits()` no longer mutates the input checkpoint's model
 *      (the `migrateModel(model)` mutation is moved out of `replayCommits`
 *      into `loadFromStorage`).
 *
 * All contracts above are implemented and the acceptance tests pass.
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useCommitLog } from '../useCommitLog'
import { saveCheckpoint, loadLatestCheckpoint } from '../idbHelpers'
import { createEmptyRootContext } from '@businessmaps/metaontology/engine/apply'
import type { RootContext } from '@businessmaps/metaontology/types/context'
import type { Command, DispatchableCommand } from '@businessmaps/metaontology/types/commands'
import type { Commit, Checkpoint } from '@businessmaps/metaontology/types/commits'
import type { IDBCheckpointRecord } from '../idbSchema'
import { resetIdb } from '../../__tests__/helpers/resetIdb'

beforeEach(async () => {
  await resetIdb()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Contract 1: Checkpoint.layout is optional ───────────────────────────────

describe('Checkpoint.layout is optional', () => {
  // Today: Checkpoint requires `layout: CanvasLayout`. This contract makes it
  // optional so a model-only consumer (in `layers/ontology/`) can checkpoint
  // without knowing about CanvasLayout.

  it('Checkpoint type has no layout field', () => {
    // Type-system test: Checkpoint no longer carries a layout field.
    const cp: Checkpoint = {
      id: 'cp',
      mapId: 'm',
      commitId: 'g',
      sequence: 0,
      branchId: 'main',
      model: createEmptyRootContext('Test'),
      timestamp: '2026-01-01',
    }
    expect((cp as any).layout).toBeUndefined()
  })

  it('replayCommits handles a checkpoint and produces { model, failures }', () => {
    const log = useCommitLog()
    log.reset()
    const baseModel = createEmptyRootContext('No Layout')
    const cp: Checkpoint = {
      id: 'cp-1',
      mapId: baseModel.uri,
      commitId: 'genesis',
      sequence: 0,
      branchId: 'main',
      model: baseModel,
      timestamp: '2026-01-01',
    }
    const result = log.replayCommits(cp, [])
    expect(result.model).toBeDefined()
    expect(result.model.uri).toBe(baseModel.uri)
    expect(result.failures).toBe(0)
  })

  it('IDB save/load roundtrip preserves an undefined layout', async () => {
    const baseModel = createEmptyRootContext('No Layout Roundtrip')
    const record: IDBCheckpointRecord = {
      id: 'cp-no-layout',
      mapId: baseModel.uri,
      branchId: 'main',
      commitId: 'genesis',
      sequence: 0,
      model: baseModel,
      timestamp: '2026-01-01',
      // no layout
    }
    await saveCheckpoint(record)

    const loaded = await loadLatestCheckpoint(baseModel.uri, 'main')
    expect(loaded).not.toBeNull()
    expect(loaded!.layout).toBeUndefined()
    expect(loaded!.model.uri).toBe(baseModel.uri)
    expect(loaded!.model.name).toBe('No Layout Roundtrip')
  })
})

// ── Contract 2: replayCommits accepts a commandFilter ───────────────────────

describe('replayCommits commandFilter', () => {
  // commandFilter allows consumers to skip commands they don't care about
  // during replay. With layout commands removed, we test it with domain
  // commands only.

  function makeFixture() {
    const baseModel = createEmptyRootContext('Filter Test')
    const cp: Checkpoint = {
      id: 'cp-1',
      mapId: baseModel.uri,
      commitId: 'genesis',
      sequence: 0,
      branchId: 'main',
      model: baseModel,
      timestamp: '2026-01-01',
    }
    const addCmd: Command = {
      type: 'context:add',
      payload: { name: 'Kept', parentUri: baseModel.uri },
    }
    const renameCmd: Command = {
      type: 'facet:add',
      payload: { contextUri: baseModel.uri, facetType: 'things', facet: { uri: 'f1', name: 'Widget' } },
    }
    const commits: Commit[] = [
      {
        id: 'c-d', mapId: baseModel.uri, sequence: 1, command: addCmd,
        inverse: { type: 'context:remove', payload: { contextUri: 'whatever' } },
        timestamp: '2026-01-02', deviceId: 'd1', branchId: 'main', parentId: 'genesis',
      },
      {
        id: 'c-f', mapId: baseModel.uri, sequence: 2, command: renameCmd,
        inverse: { type: 'facet:remove', payload: { contextUri: baseModel.uri, facetType: 'things', facetUri: 'f1' } },
        timestamp: '2026-01-03', deviceId: 'd1', branchId: 'main', parentId: 'c-d',
      },
    ]
    return { cp, commits, baseModel }
  }

  it('omitting commandFilter replays all commands', () => {
    const log = useCommitLog()
    log.reset()
    const { cp, commits } = makeFixture()

    const result = log.replayCommits(cp, commits)

    expect(Object.values(result.model.contexts)).toHaveLength(1)
    expect(Object.values(result.model.contexts)[0]!.name).toBe('Kept')
    expect(result.model.facets.things).toHaveLength(1)
  })

  it('commandFilter excludes commands matching the predicate', () => {
    const log = useCommitLog()
    log.reset()
    const { cp, commits } = makeFixture()

    // Filter out facet commands, keep context commands
    const filterOutFacets = (cmd: DispatchableCommand) => !cmd.type.startsWith('facet:')
    const result = log.replayCommits(cp, commits, filterOutFacets)

    // Context command applied
    expect(Object.values(result.model.contexts)).toHaveLength(1)
    expect(Object.values(result.model.contexts)[0]!.name).toBe('Kept')
    // Facet command skipped
    expect(result.model.facets.things).toHaveLength(0)
  })

  it('commandFilter is applied recursively inside batch commands', () => {
    const log = useCommitLog()
    log.reset()
    const baseModel = createEmptyRootContext('Recursive Filter')
    const cp: Checkpoint = {
      id: 'cp-1',
      mapId: baseModel.uri,
      commitId: 'genesis',
      sequence: 0,
      branchId: 'main',
      model: baseModel,
      timestamp: '2026-01-01',
    }

    const domainCmd: Command = {
      type: 'context:add',
      payload: { name: 'In Batch', parentUri: baseModel.uri },
    }
    const facetCmd: Command = {
      type: 'facet:add',
      payload: { contextUri: baseModel.uri, facetType: 'things', facet: { uri: 'f2', name: 'Gadget' } },
    }
    const batchCmd: DispatchableCommand = {
      type: 'batch',
      payload: { commands: [domainCmd, facetCmd], label: 'mixed' },
    }
    const batchCommit: Commit = {
      id: 'c-batch',
      mapId: baseModel.uri,
      sequence: 1,
      command: batchCmd,
      inverse: batchCmd,
      timestamp: '2026-01-02',
      deviceId: 'd1',
      branchId: 'main',
      parentId: 'genesis',
    }

    const filterOutFacets = (cmd: DispatchableCommand) => !cmd.type.startsWith('facet:')
    const result = log.replayCommits(cp, [batchCommit], filterOutFacets)

    // Domain part applied, facet part skipped
    expect(Object.values(result.model.contexts)).toHaveLength(1)
    expect(Object.values(result.model.contexts)[0]!.name).toBe('In Batch')
    expect(result.model.facets.things).toHaveLength(0)
  })

  it('commandFilter does not mutate the source commit array', () => {
    const log = useCommitLog()
    log.reset()
    const { cp, commits } = makeFixture()
    const before = JSON.stringify(commits)

    log.replayCommits(cp, commits, () => true)

    expect(JSON.stringify(commits)).toBe(before)
  })

  it('commandFilter returning all-false produces an empty replay', () => {
    const log = useCommitLog()
    log.reset()
    const { cp, commits } = makeFixture()

    const result = log.replayCommits(cp, commits, () => false)

    // No commands applied  - model matches the checkpoint
    expect(Object.keys(result.model.contexts)).toEqual(Object.keys(cp.model.contexts))
  })
})

// ── Contract 3: replayCommits is pure ───────────────────────────────────────

describe('replayCommits purity', () => {
  // Today: replayCommits calls `migrateModel(checkpoint.model)` which mutates
  // the checkpoint's model in place. This contract moves migration into the loader
  // path so replay is fully pure.

  it('replayCommits does not mutate checkpoint.model.schemaVersion', () => {
    const log = useCommitLog()
    log.reset()
    // Construct a model with an explicitly stale schemaVersion. If replay
    // still ran migrateModel, this would be bumped to CURRENT_SCHEMA_VERSION.
    const baseModel = createEmptyRootContext('Pure') as RootContext & { schemaVersion?: number }
    baseModel.schemaVersion = 0
    const before = JSON.stringify(baseModel)
    const cp: Checkpoint = {
      id: 'cp-pure',
      mapId: baseModel.uri,
      commitId: 'genesis',
      sequence: 0,
      branchId: 'main',
      model: baseModel,
      timestamp: '2026-01-01',
    }

    log.replayCommits(cp, [])

    expect(JSON.stringify(baseModel)).toBe(before)
    expect((baseModel as { schemaVersion?: number }).schemaVersion).toBe(0)
  })

  it('replayCommits is referentially transparent', () => {
    const log = useCommitLog()
    log.reset()
    const baseModel = createEmptyRootContext('Transparent')
    const cp: Checkpoint = {
      id: 'cp-rt',
      mapId: baseModel.uri,
      commitId: 'genesis',
      sequence: 0,
      branchId: 'main',
      model: baseModel,
      timestamp: '2026-01-01',
    }

    const domainCmd: Command = {
      type: 'context:add',
      payload: { name: 'X', parentUri: baseModel.uri, uri: 'fixed-id' },
    }
    const commits: Commit[] = [{
      id: 'c-rt',
      mapId: baseModel.uri,
      sequence: 1,
      command: domainCmd,
      inverse: { type: 'context:remove', payload: { contextUri: 'fixed-id' } },
      timestamp: '2026-01-02',
      deviceId: 'd1',
      branchId: 'main',
      parentId: 'genesis',
    }]

    const inputSnap = JSON.stringify({ cp, commits })

    const a = log.replayCommits(cp, commits)
    const b = log.replayCommits(cp, commits)

    // Same outputs
    expect(a.model.contexts).toEqual(b.model.contexts)
    expect(a.failures).toEqual(b.failures)
    // Inputs unchanged
    expect(JSON.stringify({ cp, commits })).toBe(inputSnap)
  })
})

// ── Contract 4: backward compatibility ──────────────────────────────────────

describe('backward compatibility', () => {
  it('a checkpoint replays domain commands correctly', () => {
    const log = useCommitLog()
    log.reset()
    const baseModel = createEmptyRootContext('Backward')

    const cp: Checkpoint = {
      id: 'cp-v1',
      mapId: baseModel.uri,
      commitId: 'genesis',
      sequence: 0,
      branchId: 'main',
      model: baseModel,
      timestamp: '2026-01-01',
    }

    const domainCmd: Command = { type: 'context:add', payload: { name: 'D', parentUri: baseModel.uri } }
    const commits: Commit[] = [
      {
        id: 'c-1', mapId: baseModel.uri, sequence: 1, command: domainCmd,
        inverse: { type: 'context:remove', payload: { contextUri: 'whatever' } },
        timestamp: '2026-01-02', deviceId: 'd1', branchId: 'main', parentId: 'genesis',
      },
    ]

    const result = log.replayCommits(cp, commits)
    expect(result.model.uri).toBe(baseModel.uri)
    expect(Object.values(result.model.contexts)).toHaveLength(1)
    expect(Object.values(result.model.contexts)[0]!.name).toBe('D')
  })
})
