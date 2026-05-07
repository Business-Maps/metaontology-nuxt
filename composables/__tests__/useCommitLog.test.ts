/**
 * Tests for `useCommitLog`  - the append-only commit log composable that backs
 * every dispatch.
 *
 * Why this test file exists:
 *   `useCommitLog.ts` had no test file before the layer extraction. The only
 *   way to know the move was safe was to pin its current behavior with tests
 *   *first*. Every test in
 *   this file is a regression assertion: if the behavior changes, the test
 *   fails. The test passes against both the pre-move and post-move
 *   implementations without modification.
 *
 * What this file covers:
 *   - `appendCommit`  - append a commit + inverse, advance sequence, push to undo
 *   - `popUndo` / `popRedo`  - undo stack lifecycle, MAX_UNDO eviction
 *   - `replayCommits`  - pure replay of domain commands from a checkpoint
 *   - `loadFromStorage`  - load checkpoint + commits since, replay, set state
 *   - `initFromSnapshot`  - fresh genesis checkpoint creation
 *   - `forceFlush`  - flush pending commits to IDB and create a checkpoint
 *   - `bindStateAccessors` + `createCheckpointNow`  - checkpoint serialization
 *   - `reset`  - clear all state
 *
 * What it deliberately does NOT cover (out of scope for this file):
 *   - The `commandFilter` parameter contract  -
 *     tested in `useCommitLogPhase1.test.ts`.
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useCommitLog } from '../useCommitLog'
import { resetIdb } from '../../__tests__/helpers/resetIdb'
import {
  saveCommits,
  saveCheckpoint as idbSaveCheckpoint,
  loadLatestCheckpoint,
  loadCommitsSince,
} from '../idbHelpers'
import { createEmptyRootContext } from '@businessmaps/metaontology/engine/apply'
import { applyCommand } from '@businessmaps/metaontology/engine/apply'
import type { Command, DispatchableCommand } from '@businessmaps/metaontology/types/commands'
import type { Commit, Checkpoint } from '@businessmaps/metaontology/types/commits'
import type { IDBCommitRecord, IDBCheckpointRecord } from '../idbSchema'

/** Build a `context:add` command and its inverse for round-trip testing. */
function addContextCmd(name: string, parentUri: string): { cmd: Command; inverse: Command } {
  const cmd: Command = { type: 'context:add', payload: { name, parentUri } }
  // Inverse depends on the generated uri; tests synthesize the inverse manually
  // when they care about the generated uri.
  const inverse: Command = { type: 'context:remove', payload: { contextUri: 'placeholder' } }
  return { cmd, inverse }
}

beforeEach(async () => {
  await resetIdb()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Initial state ───────────────────────────────────────────────────────────

describe('useCommitLog  - initial state', () => {
  it('starts inactive with empty stacks and zero sequence', () => {
    const log = useCommitLog()
    log.reset() // start from a clean slate (the singleton may carry state from another test in the same module)
    expect(log.active.value).toBe(false)
    expect(log.commits.value).toEqual([])
    expect(log.canUndo.value).toBe(false)
    expect(log.canRedo.value).toBe(false)
    expect(log.headCommitId.value).toBeNull()
    expect(log.latestCheckpoint.value).toBeNull()
    expect(log.nextSequence.value).toBe(0)
    expect(log.undoStack.value).toEqual([])
  })

  it('setDeviceId / getDeviceId roundtrip', () => {
    const log = useCommitLog()
    log.reset()
    log.setDeviceId('device-abc')
    expect(log.getDeviceId()).toBe('device-abc')
  })
})

// ── initFromSnapshot ────────────────────────────────────────────────────────

describe('initFromSnapshot', () => {
  it('creates a genesis checkpoint and activates the log', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Genesis Test')

    await log.initFromSnapshot(model.uri, model)

    expect(log.active.value).toBe(true)
    expect(log.mapId.value).toBe(model.uri)
    expect(log.activeBranchId.value).toBe('main')
    expect(log.commits.value).toHaveLength(0)
    expect(log.headCommitId.value).toBe('genesis')
    expect(log.latestCheckpoint.value).not.toBeNull()
    expect(log.latestCheckpoint.value!.commitId).toBe('genesis')
    expect(log.latestCheckpoint.value!.sequence).toBe(0)
  })

  it('persists the genesis checkpoint to IDB', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('IDB Genesis')

    await log.initFromSnapshot(model.uri, model)

    const persisted = await loadLatestCheckpoint(model.uri, 'main')
    expect(persisted).not.toBeNull()
    expect(persisted!.commitId).toBe('genesis')
    expect(persisted!.model.uri).toBe(model.uri)
    expect(persisted!.model.name).toBe('IDB Genesis')
  })

  it('resets undo and redo stacks', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Reset Test')
    await log.initFromSnapshot(model.uri, model)
    expect(log.undoStack.value).toEqual([])
    expect(log.canRedo.value).toBe(false)
  })
})

// ── appendCommit ────────────────────────────────────────────────────────────

describe('appendCommit', () => {
  it('appends a commit with monotonically increasing sequence', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Append Test')
    await log.initFromSnapshot(model.uri, model)

    const { cmd: cmd1, inverse: inv1 } = addContextCmd('A', model.uri)
    const c1 = log.appendCommit(cmd1, inv1)
    const { cmd: cmd2, inverse: inv2 } = addContextCmd('B', model.uri)
    const c2 = log.appendCommit(cmd2, inv2)
    const { cmd: cmd3, inverse: inv3 } = addContextCmd('C', model.uri)
    const c3 = log.appendCommit(cmd3, inv3)

    expect(log.commits.value).toHaveLength(3)
    expect(c1.sequence).toBe(1)
    expect(c2.sequence).toBe(2)
    expect(c3.sequence).toBe(3)
    expect(log.nextSequence.value).toBe(4)
  })

  it('sets parentId to the previous commit id', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Parent Test')
    await log.initFromSnapshot(model.uri, model)

    const c1 = log.appendCommit(addContextCmd('A', model.uri).cmd, addContextCmd('A', model.uri).inverse)
    const c2 = log.appendCommit(addContextCmd('B', model.uri).cmd, addContextCmd('B', model.uri).inverse)

    // First commit's parent is the genesis commit
    expect(c1.parentId).toBe('genesis')
    // Second commit's parent is the first commit
    expect(c2.parentId).toBe(c1.id)
  })

  it('sets the deviceId from setDeviceId', async () => {
    const log = useCommitLog()
    log.reset()
    log.setDeviceId('device-abc')
    const model = createEmptyRootContext('Device Test')
    await log.initFromSnapshot(model.uri, model)

    const commit = log.appendCommit(
      addContextCmd('A', model.uri).cmd,
      addContextCmd('A', model.uri).inverse,
    )
    expect(commit.deviceId).toBe('device-abc')
  })

  it('pushes the commit onto the undo stack', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Undo Push')
    await log.initFromSnapshot(model.uri, model)

    const cmd = addContextCmd('A', model.uri)
    log.appendCommit(cmd.cmd, cmd.inverse)

    expect(log.undoStack.value).toHaveLength(1)
    expect(log.canUndo.value).toBe(true)
  })

  it('clears the redo stack on a new commit', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Redo Clear')
    await log.initFromSnapshot(model.uri, model)

    // Append, undo, then append again  - the undo should drop from redo
    log.appendCommit(addContextCmd('A', model.uri).cmd, addContextCmd('A', model.uri).inverse)
    log.popUndo()
    expect(log.canRedo.value).toBe(true)

    log.appendCommit(addContextCmd('B', model.uri).cmd, addContextCmd('B', model.uri).inverse)
    expect(log.canRedo.value).toBe(false)
  })

  it('caps the undo stack at MAX_UNDO (50)', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Max Undo')
    await log.initFromSnapshot(model.uri, model)

    // Append 60 commits  - undo stack should hold only the last 50
    for (let i = 0; i < 60; i++) {
      log.appendCommit(
        addContextCmd(`C${i}`, model.uri).cmd,
        addContextCmd(`C${i}`, model.uri).inverse,
      )
    }
    expect(log.undoStack.value).toHaveLength(50)
    // Commits array still holds all 60  - only the undo stack is capped
    expect(log.commits.value).toHaveLength(60)
  })
})

// ── popUndo / popRedo ───────────────────────────────────────────────────────

describe('popUndo / popRedo', () => {
  it('popUndo returns the last commit and moves it to redo', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Pop Test')
    await log.initFromSnapshot(model.uri, model)

    const c1 = log.appendCommit(addContextCmd('A', model.uri).cmd, addContextCmd('A', model.uri).inverse)
    const c2 = log.appendCommit(addContextCmd('B', model.uri).cmd, addContextCmd('B', model.uri).inverse)

    const popped = log.popUndo()
    expect(popped).not.toBeNull()
    expect(popped!.commitId).toBe(c2.id)
    expect(log.canRedo.value).toBe(true)
    expect(log.undoStack.value).toHaveLength(1) // only c1 left

    const popped2 = log.popUndo()
    expect(popped2!.commitId).toBe(c1.id)
    expect(log.undoStack.value).toHaveLength(0)
    expect(log.canUndo.value).toBe(false)
  })

  it('popUndo returns null when there is nothing to undo', () => {
    const log = useCommitLog()
    log.reset()
    expect(log.popUndo()).toBeNull()
  })

  it('popRedo returns the most-recently-undone commit', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Redo Test')
    await log.initFromSnapshot(model.uri, model)

    const c1 = log.appendCommit(addContextCmd('A', model.uri).cmd, addContextCmd('A', model.uri).inverse)
    log.popUndo()
    const redoEntry = log.popRedo()
    expect(redoEntry).not.toBeNull()
    expect(redoEntry!.commitId).toBe(c1.id)
  })

  it('popRedo returns null when there is nothing to redo', () => {
    const log = useCommitLog()
    log.reset()
    expect(log.popRedo()).toBeNull()
  })
})

// ── replayCommits ───────────────────────────────────────────────────────────

describe('replayCommits', () => {
  it('replays domain commands against the checkpoint model', () => {
    const log = useCommitLog()
    log.reset()
    const baseModel = createEmptyRootContext('Replay Base')

    const checkpoint: Checkpoint = {
      id: 'cp-1',
      mapId: baseModel.uri,
      commitId: 'genesis',
      sequence: 0,
      branchId: 'main',
      model: baseModel,
      timestamp: '2026-01-01',
    }

    const cmd: Command = { type: 'context:add', payload: { name: 'Replayed', parentUri: baseModel.uri } }
    const commits: Commit[] = [{
      id: 'c-1',
      mapId: baseModel.uri,
      sequence: 1,
      command: cmd,
      inverse: { type: 'context:remove', payload: { contextUri: 'whatever' } },
      timestamp: '2026-01-02',
      deviceId: 'd1',
      branchId: 'main',
      parentId: 'genesis',
    }]

    const result = log.replayCommits(checkpoint, commits)

    expect(Object.values(result.model.contexts)).toHaveLength(1)
    expect(Object.values(result.model.contexts)[0]!.name).toBe('Replayed')
    expect(result.failures).toBe(0)
  })

  it('replays batch commands with multiple domain commands', () => {
    const log = useCommitLog()
    log.reset()
    const baseModel = createEmptyRootContext('Batch Replay')

    const checkpoint: Checkpoint = {
      id: 'cp-1',
      mapId: baseModel.uri,
      commitId: 'genesis',
      sequence: 0,
      branchId: 'main',
      model: baseModel,
      timestamp: '2026-01-01',
    }

    const cmd1: Command = { type: 'context:add', payload: { name: 'First', parentUri: baseModel.uri } }
    const cmd2: Command = { type: 'context:add', payload: { name: 'Second', parentUri: baseModel.uri } }
    const batch: DispatchableCommand = {
      type: 'batch',
      payload: { commands: [cmd1, cmd2], label: 'two contexts' },
    }
    const commits: Commit[] = [{
      id: 'c-1',
      mapId: baseModel.uri,
      sequence: 1,
      command: batch,
      inverse: batch,
      timestamp: '2026-01-02',
      deviceId: 'd1',
      branchId: 'main',
      parentId: 'genesis',
    }]

    const result = log.replayCommits(checkpoint, commits)

    expect(Object.values(result.model.contexts)).toHaveLength(2)
    const names = Object.values(result.model.contexts).map(c => c!.name).sort()
    expect(names).toEqual(['First', 'Second'])
  })

  it('is idempotent: replaying twice produces equivalent state', () => {
    const log = useCommitLog()
    log.reset()
    const baseModel = createEmptyRootContext('Idempotent Replay')

    const checkpoint: Checkpoint = {
      id: 'cp-1',
      mapId: baseModel.uri,
      commitId: 'genesis',
      sequence: 0,
      branchId: 'main',
      model: baseModel,
      timestamp: '2026-01-01',
    }

    const domainCmd: Command = { type: 'context:add', payload: { name: 'X', parentUri: baseModel.uri, uri: 'fixed-id' } }
    const commits: Commit[] = [{
      id: 'c-1',
      mapId: baseModel.uri,
      sequence: 1,
      command: domainCmd,
      inverse: { type: 'context:remove', payload: { contextUri: 'fixed-id' } },
      timestamp: '2026-01-02',
      deviceId: 'd1',
      branchId: 'main',
      parentId: 'genesis',
    }]

    const a = log.replayCommits(checkpoint, commits)
    const b = log.replayCommits(checkpoint, commits)
    expect(a.model.contexts).toEqual(b.model.contexts)
    expect(a.failures).toEqual(b.failures)
  })

  it('does not mutate the input checkpoint structure', () => {
    // CONTRACT: replay is fully pure. Schema migration
    // moved out of `replayCommits` and into `loadFromStorage`, so the
    // checkpoint passed to replay is left entirely untouched  - no
    // schemaVersion bump, no command application onto the input. The result's
    // model is a new value; the input's `id`, `name`, `contexts`,
    // `facets`, `links`, `symbols`, `commitId`, `branchId`,
    // `sequence`, `timestamp` all stay the same as before the call.
    const log = useCommitLog()
    log.reset()
    const baseModel = createEmptyRootContext('No Mutate')

    const checkpoint: Checkpoint = {
      id: 'cp-1',
      mapId: baseModel.uri,
      commitId: 'genesis',
      sequence: 0,
      branchId: 'main',
      model: baseModel,
      timestamp: '2026-01-01',
    }
    // Capture the comparable subset  - everything except `model.schemaVersion`,
    // which migration is allowed to set.
    const beforeId = checkpoint.id
    const beforeMapId = checkpoint.mapId
    const beforeCommitId = checkpoint.commitId
    const beforeSequence = checkpoint.sequence
    const beforeBranchId = checkpoint.branchId
    const beforeTimestamp = checkpoint.timestamp
    const beforeContexts = JSON.stringify(checkpoint.model.contexts)
    const beforeFacets = JSON.stringify(checkpoint.model.facets)
    const beforeLinks = JSON.stringify(checkpoint.model.links)
    const beforeSymbols = JSON.stringify(checkpoint.model.symbols)

    const domainCmd: Command = { type: 'context:add', payload: { name: 'Y', parentUri: baseModel.uri } }
    const commits: Commit[] = [{
      id: 'c-1',
      mapId: baseModel.uri,
      sequence: 1,
      command: domainCmd,
      inverse: { type: 'context:remove', payload: { contextUri: 'whatever' } },
      timestamp: '2026-01-02',
      deviceId: 'd1',
      branchId: 'main',
      parentId: 'genesis',
    }]

    log.replayCommits(checkpoint, commits)

    // Top-level fields untouched
    expect(checkpoint.id).toBe(beforeId)
    expect(checkpoint.mapId).toBe(beforeMapId)
    expect(checkpoint.commitId).toBe(beforeCommitId)
    expect(checkpoint.sequence).toBe(beforeSequence)
    expect(checkpoint.branchId).toBe(beforeBranchId)
    expect(checkpoint.timestamp).toBe(beforeTimestamp)
    // Model contents untouched  - the new context produced by replay should
    // appear in the result, NOT in the checkpoint's model
    expect(JSON.stringify(checkpoint.model.contexts)).toBe(beforeContexts)
    expect(JSON.stringify(checkpoint.model.facets)).toBe(beforeFacets)
    expect(JSON.stringify(checkpoint.model.links)).toBe(beforeLinks)
    expect(JSON.stringify(checkpoint.model.symbols)).toBe(beforeSymbols)
  })
})

// ── loadFromStorage ─────────────────────────────────────────────────────────

describe('loadFromStorage', () => {
  it('returns null when there is no checkpoint', async () => {
    const log = useCommitLog()
    log.reset()
    const result = await log.loadFromStorage('nonexistent', 'main')
    expect(result).toBeNull()
  })

  it('loads a saved checkpoint and replays subsequent commits', async () => {
    // Set up: write a checkpoint and a commit directly to IDB, then load.
    const mapId = 'test-map-load'
    const baseModel = createEmptyRootContext('Load Test')
    baseModel.uri = mapId

    const cp: IDBCheckpointRecord = {
      id: 'cp-stored',
      mapId,
      branchId: 'main',
      commitId: 'genesis',
      sequence: 0,
      model: baseModel,
      timestamp: '2026-01-01',
    }
    await idbSaveCheckpoint(cp)

    const commit: IDBCommitRecord = {
      id: 'c-stored-1',
      mapId,
      branchId: 'main',
      sequence: 1,
      command: { type: 'context:add', payload: { name: 'After Load', parentUri: mapId } },
      inverse: { type: 'context:remove', payload: { contextUri: 'whatever' } },
      timestamp: '2026-01-02',
      deviceId: 'd1',
      parentId: 'genesis',
    }
    await saveCommits([commit])

    const log = useCommitLog()
    log.reset()
    const result = await log.loadFromStorage(mapId, 'main')

    expect(result).not.toBeNull()
    expect(Object.values(result!.model.contexts)).toHaveLength(1)
    expect(Object.values(result!.model.contexts)[0]!.name).toBe('After Load')
    expect(log.active.value).toBe(true)
    expect(log.mapId.value).toBe(mapId)
    expect(log.commits.value).toHaveLength(1)
    expect(log.nextSequence.value).toBe(2) // last commit was sequence 1, next is 2
    expect(log.headCommitId.value).toBe('c-stored-1')
  })

  it('sets headCommitId to the checkpoint commitId when no commits exist', async () => {
    const mapId = 'test-map-bare'
    const cp: IDBCheckpointRecord = {
      id: 'cp-bare',
      mapId,
      branchId: 'main',
      commitId: 'genesis',
      sequence: 0,
      model: { ...createEmptyRootContext('Bare'), id: mapId },
      timestamp: '2026-01-01',
    }
    await idbSaveCheckpoint(cp)

    const log = useCommitLog()
    log.reset()
    await log.loadFromStorage(mapId, 'main')
    expect(log.headCommitId.value).toBe('genesis')
    expect(log.nextSequence.value).toBe(1)
  })

  it('clears the undo and redo stacks on load', async () => {
    const mapId = 'test-map-stacks'
    const cp: IDBCheckpointRecord = {
      id: 'cp-stacks',
      mapId,
      branchId: 'main',
      commitId: 'genesis',
      sequence: 0,
      model: { ...createEmptyRootContext('Stacks'), id: mapId },
      timestamp: '2026-01-01',
    }
    await idbSaveCheckpoint(cp)

    const log = useCommitLog()
    log.reset()
    // Pre-load: simulate an undo stack from a prior session by appending
    const otherModel = createEmptyRootContext('Pre')
    await log.initFromSnapshot(otherModel.uri, otherModel, )
    log.appendCommit(
      addContextCmd('Old', otherModel.uri).cmd,
      addContextCmd('Old', otherModel.uri).inverse,
    )
    expect(log.canUndo.value).toBe(true)

    await log.loadFromStorage(mapId, 'main')
    expect(log.canUndo.value).toBe(false)
    expect(log.canRedo.value).toBe(false)
  })
})

// ── createCheckpointNow + bindStateAccessors ───────────────────────────────

describe('createCheckpointNow', () => {
  it('writes a checkpoint to IDB using the bound state accessors', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Checkpoint Test')
    await log.initFromSnapshot(model.uri, model)

    // Mutate the model after init to prove the checkpoint reflects current state
    const updated = applyCommand(model, { type: 'context:add', payload: { name: 'Added', parentUri: model.uri } })
    expect(updated.success).toBe(true)
    const currentRoot = updated.state

    log.bindStateAccessors(() => currentRoot)

    // Append a commit so headCommitId is set (createCheckpointNow needs it)
    log.appendCommit(
      { type: 'context:add', payload: { name: 'Added', parentUri: model.uri } },
      { type: 'context:remove', payload: { contextUri: 'whatever' } },
    )

    await log.createCheckpointNow()

    const persisted = await loadLatestCheckpoint(model.uri, 'main')
    expect(persisted).not.toBeNull()
    expect(Object.values(persisted!.model.contexts)).toHaveLength(1)
    expect(Object.values(persisted!.model.contexts)[0]!.name).toBe('Added')
  })

  it('is a no-op when no state accessors are bound', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('No Bind')
    await log.initFromSnapshot(model.uri, model)

    // No bindStateAccessors call, no headCommitId beyond genesis
    log.appendCommit(
      { type: 'context:add', payload: { name: 'X', parentUri: model.uri } },
      { type: 'context:remove', payload: { contextUri: 'whatever' } },
    )

    // Should not throw  - accessors are unbound, function exits early
    await expect(log.createCheckpointNow()).resolves.toBeUndefined()
  })
})

// ── forceFlush ──────────────────────────────────────────────────────────────

describe('forceFlush', () => {
  it('flushes pending commits to IDB', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Force Flush')
    await log.initFromSnapshot(model.uri, model)
    log.bindStateAccessors(() => model)

    log.appendCommit(
      { type: 'context:add', payload: { name: 'P1', parentUri: model.uri } },
      { type: 'context:remove', payload: { contextUri: 'whatever' } },
    )
    log.appendCommit(
      { type: 'context:add', payload: { name: 'P2', parentUri: model.uri } },
      { type: 'context:remove', payload: { contextUri: 'whatever' } },
    )

    await log.forceFlush()

    const stored = await loadCommitsSince(model.uri, 'main', 0)
    expect(stored).toHaveLength(2)
    expect(stored.map(s => s.sequence).sort()).toEqual([1, 2])
  })

  it('creates a checkpoint after flushing', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Flush + CP')
    await log.initFromSnapshot(model.uri, model)
    log.bindStateAccessors(() => model)

    log.appendCommit(
      { type: 'context:add', payload: { name: 'X', parentUri: model.uri } },
      { type: 'context:remove', payload: { contextUri: 'whatever' } },
    )

    await log.forceFlush()

    const persisted = await loadLatestCheckpoint(model.uri, 'main')
    expect(persisted).not.toBeNull()
    // After flush, the latest checkpoint should reflect the post-commit head
    expect(persisted!.commitId).toBe(log.headCommitId.value)
  })
})

// ── reset ──────────────────────────────────────────────────────────────────

describe('reset', () => {
  it('clears all in-memory state', async () => {
    const log = useCommitLog()
    log.reset()
    const model = createEmptyRootContext('Reset')
    await log.initFromSnapshot(model.uri, model)
    log.appendCommit(
      addContextCmd('A', model.uri).cmd,
      addContextCmd('A', model.uri).inverse,
    )

    log.reset()

    expect(log.active.value).toBe(false)
    expect(log.mapId.value).toBe('')
    expect(log.commits.value).toEqual([])
    expect(log.headCommitId.value).toBeNull()
    expect(log.latestCheckpoint.value).toBeNull()
    expect(log.nextSequence.value).toBe(0)
    expect(log.undoStack.value).toEqual([])
    expect(log.canUndo.value).toBe(false)
    expect(log.canRedo.value).toBe(false)
  })
})

// ── Singleton behavior ─────────────────────────────────────────────────────

describe('singleton', () => {
  it('useCommitLog() returns the same instance on every call', async () => {
    // CONTRACT: `useCommitLog` is a module-level singleton per
    // JavaScript context. Multiple call sites (canvas store, sync engine,
    // collab wiring, UI components) all see the same state. Cross-tab
    // isolation comes from separate module loads, not from per-call factoring.
    const a = useCommitLog()
    const b = useCommitLog()
    a.reset()
    const model = createEmptyRootContext('Singleton')
    await a.initFromSnapshot(model.uri, model)

    // `b` sees the same state as `a`
    expect(a).toBe(b)
    expect(b.active.value).toBe(true)
    expect(b.mapId.value).toBe(model.uri)
  })
})
