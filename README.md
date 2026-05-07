# @businessmaps/metaontology-nuxt

Vue 3 / Nuxt 4 integration layer for `@businessmaps/metaontology`. Provides reactive composables for commit-sourced persistence, cloud sync, cross-tab coordination, and a reactive triple store.

`@businessmaps/metaontology` is a pure TypeScript package. It has no opinion about where your state lives, how it's persisted, or how mutations flow through a UI framework. That's deliberate - it keeps the engine testable and portable. But if you're building a browser application with Vue and Nuxt, you need the glue: reactive state, IndexedDB persistence, undo/redo session management, cross-tab coordination, and sync. Writing that glue correctly means handling debounced flushing, unload safety, checkpoint-and-replay loading, three-way merge on pull, echo prevention across tabs, and exponential backoff on network failures.

This package is that glue. It wraps the pure engine in six composables that are auto-imported by Nuxt's layer convention, so consumers get reactive commit-sourced persistence and sync without writing any of the plumbing themselves. State is singleton per tab (module-level, not per-component), IndexedDB connection ownership lives here (one upgrade callback per database), and sync is transport-agnostic - the package defines the `SyncAdapter` interface, consumers provide implementations.

```ts
import { useModelStore, createTripleIndex } from '@businessmaps/metaontology-nuxt'

const store = useModelStore()

// Load a map from IndexedDB (checkpoint + replay)
const model = await store.loadModel('my-map')

// Create a reactive triple index
const triples = createTripleIndex(() => store.root!)

// O(1) lookup: what type is this entity?
triples.entityType('thing-order')  // 'Thing'

// All entities linked by 'performs'
triples.byPredicate('performs')    // Triple[]
```

---

## Getting started

```bash
npm install @businessmaps/metaontology-nuxt
```

### 1. Extend the layer

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  extends: ['@businessmaps/metaontology-nuxt'],
})
```

Composables in the layer's `composables/` directory are auto-imported by Nuxt. No manual registration needed.

### 2. Wire the store

```ts
// composables/useMyStore.ts
import { useModelStore, createTripleIndex } from '@businessmaps/metaontology-nuxt'
import { applyCommand, computeInverse } from '@businessmaps/metaontology/engine'
import type { RootContext } from '@businessmaps/metaontology/types/context'

export function useMyStore() {
  const modelStore = useModelStore()
  const commitLog = modelStore.commitLog

  // Reactive triple index over the current model
  const tripleIndex = createTripleIndex(() => modelStore.root!)

  function dispatch(cmd) {
    const before = modelStore.root!
    const result = applyCommand(before, cmd)
    if (!result.success) return result

    modelStore.root = result.state
    const inverse = computeInverse(cmd, before, result.state)
    commitLog.appendCommit(cmd, inverse)

    return result
  }

  return { root: modelStore.root, tripleIndex, dispatch }
}
```

### 3. Explicit imports (non-Nuxt)

For tools and scripts that don't run inside Nuxt, import directly:

```ts
import { useCommitLog } from '@businessmaps/metaontology-nuxt/composables/useCommitLog'
import { createTripleIndex } from '@businessmaps/metaontology-nuxt/composables/useTripleStore'
```

The barrel `index.ts` re-exports everything from `@businessmaps/metaontology` plus all composables, so a single import source covers both packages:

```ts
import { defineThing, useModelStore, createTripleIndex }
  from '@businessmaps/metaontology-nuxt'
```

---

## Composables

All composables are singletons per JavaScript context (per browser tab). Multiple call sites see the same state. Cross-tab isolation comes from the module being loaded separately in each tab, not from per-call instantiation.

### useCommitLog

Append-only commit log with undo/redo, checkpoint-and-replay loading, and unload safety.

```ts
const commitLog = useCommitLog()

// Append a commit (command + its computed inverse)
commitLog.appendCommit(command, inverse)

// Undo: pop the inverse command, dispatch it
const entry = commitLog.popUndo()
if (entry) dispatch(entry.inverseCommand)

// Redo: pop the original command, re-dispatch it
const redo = commitLog.popRedo()
if (redo) dispatch(redo.originalCommand)

// Load from IndexedDB: latest checkpoint + replay commits since
const result = await commitLog.loadFromStorage('my-map', 'main')
// result: { model, m0, replayFailures }

// Initialize a new map with a genesis checkpoint
await commitLog.initFromSnapshot('new-map', emptyRootContext)

// Subscribe to commit appends (for cross-tab broadcast, telemetry, etc.)
const unbind = commitLog.onAppend((commit) => {
  console.log('committed:', commit.id, commit.command.type)
})
```

Key behaviors:
- Debounced flush to IndexedDB (800ms after last append)
- Cap-triggered flush when the pending buffer exceeds 25 commits (prevents debounce starvation during rapid AI tool calls)
- Automatic checkpointing every 100 commits
- Unload safety via `visibilitychange`, `pagehide`, and `beforeunload` handlers
- Session undo/redo stacks (max 50 entries, reset on page reload)
- Schema migration runs on the checkpoint at load time, not inside `applyCommand`

### useSyncEngine

Cloud sync state machine with debounced push, pull with fast-forward or three-way merge, and exponential backoff.

```ts
const sync = useSyncEngine()

// Activate with an adapter and a host
sync.activate(adapter, {
  getRoot: () => store.root,
  applyFastForward: (commits) => { /* replay remote commits */ },
  applyMerged: (mergedModel) => { /* install merged model */ },
  onConflict: (result) => { /* surface conflicts for resolution */ },
})

// Schedule a push after the 5s debounce
sync.schedulePush()

// Manual push/pull
await sync.push()
await sync.pull()

// Full cycle: pull then push
await sync.sync()

// Read-only reactive state
sync.status.value      // 'idle' | 'pushing' | 'pulling' | 'conflict' | 'error'
sync.pendingCount.value // number of unsynced commits
sync.lastError.value   // friendly error message or null
sync.enabled.value     // true if activated

// Restore persisted sync cursor on page load
await sync.primeCursor('my-map', 'main')

// Deactivate
sync.deactivate()
```

Key behaviors:
- 5-second debounce on push (coalesces rapid edits)
- Exponential backoff on failure (5s base, 60s cap, max 5 retries)
- Error classification: `network`, `cors`, `auth`, `conflict`, `server`, `crypto`, `unknown`
- Console log throttling (one line per error category per retry cycle)
- Pull handles two cases: fast-forward (no local divergence) or three-way merge (local and remote diverged)
- Push filter support for cross-tab dedup (set by `useCrossTab`)
- Sync cursor persisted to IDB so page refresh doesn't re-push already-synced commits

### createTripleIndex

Vue `computed()` wrapper around the pure triple projection. Rebuilds reactively when the model changes.

```ts
import { createTripleIndex } from '@businessmaps/metaontology-nuxt'

const index = createTripleIndex(
  () => store.root,      // reactive model accessor
  () => store.m0State,   // optional M0 state for cross-tier triples
)

// O(1) lookups
index.bySubject('thing-order')             // all triples about this entity
index.byPredicate('performs')              // all 'performs' relationships
index.bySP('persona-1', 'performs')        // what does persona-1 perform?
index.byPO('performs', 'action-checkout')  // who performs the checkout action?
index.has('p1', 'performs', 'a1')          // existence check

// Convenience helpers
index.objectIds('persona-1', 'performs')   // string[] of target entity IDs
index.subjectIds('action-1', 'performs')   // string[] of source entity IDs
index.firstObjectId('p1', 'owns')          // string | undefined (1:1 relationships)
index.entityType('thing-order')            // 'Thing' | 'Persona' | ...
```

This is a factory, not a singleton. Each call creates a new reactive index bound to the provided accessor. Use one per store.

### useModelStore

High-level CRUD over maps in IndexedDB. Wraps `useCommitLog` with load, save, list, and delete operations.

```ts
const store = useModelStore()

// Load a map (checkpoint + replay)
const model = await store.loadModel('my-map', 'main')

// Save a new map (genesis checkpoint)
await store.saveModel(newRootContext)

// List all persisted map IDs
const mapIds = await store.listMaps()

// Delete a map and all its commits, checkpoints, and branch heads
await store.deleteMap('old-map')

// Reactive state
store.root.value         // RootContext | null
store.isLoaded.value     // boolean
store.loading.value      // boolean
store.currentMapId.value // string
store.error.value        // string | null

// Access the underlying commit log for advanced operations
store.commitLog.canUndo.value  // boolean
```

### useCrossTab

BroadcastChannel-based cross-tab commit relay. When two browser tabs have the same map open, edits in one tab appear in the other without a server round-trip.

```ts
const crossTab = useCrossTab()

// Activate for a map with a host that handles incoming commits
crossTab.activate('my-map', {
  applyRemoteCommit: (commit) => {
    // Apply the command to local model state.
    // Must NOT call appendCommit (which would re-broadcast).
  },
})

// Per-tab identity (stable for the life of this tab)
crossTab.getTabId()  // string

// Check if a commit was received from another tab
crossTab.wasReceivedFromAnotherTab(commitId)  // boolean

// Deactivate (closes the BroadcastChannel)
crossTab.deactivate()
```

Key behaviors:
- Per-tab identity via `nanoid()` for echo prevention
- Automatic push filter installation on `useSyncEngine` so commits received cross-tab are not re-pushed to the cloud by this tab
- Idempotent receive (duplicate commit IDs are dropped)
- Graceful degradation when `BroadcastChannel` is unavailable (non-browser environments)

### syncTypes

Types and utilities for the sync adapter contract. Not a composable, but auto-imported alongside the composables.

```ts
import type { SyncAdapter, SyncStatus, SyncErrorCategory,
  PushResult, PullResult, SyncTargetDescriptor } from '@businessmaps/metaontology-nuxt'
import { classifySyncError, friendlySyncErrorMessage } from '@businessmaps/metaontology-nuxt'

// Classify any thrown error
classifySyncError(new Error('Failed to fetch'))  // 'network'
classifySyncError({ statusCode: 401 })           // 'auth'
classifySyncError({ statusCode: 409 })           // 'conflict'

// User-facing message
friendlySyncErrorMessage('network')  // 'Cloud unreachable - working locally'
friendlySyncErrorMessage('auth')     // 'Sign-in expired'
```

---

## IDB schema

The layer owns the IndexedDB connection (because IDB only allows one upgrade callback per database version). The schema defines 11 stores in a single `businessmaps` database:

**Model-tier (layer-owned, fully typed):**

| Store | Key | Indexes | Purpose |
|---|---|---|---|
| `commits` | `id` | `by-map-branch-seq` | Append-only command log |
| `checkpoints` | `id` | `by-map-branch-seq` | Periodic model snapshots |
| `heads` | `[mapId, branchId]` | - | Branch pointers |

**Legacy / canvas-tier (app-owned, typed as `unknown` at the layer):**

`documents`, `branches`, `history`, `config`, `tabs`, `conversations`, `blobs`, `sync_queue`

The layer creates all stores in the upgrade callback but only reads/writes the model-tier stores. App code accesses the same connection via a thin proxy that re-exports `getDb` and `closeDb`.

---

## Implementing a SyncAdapter

The `SyncAdapter` interface is transport-agnostic. The sync engine calls `push`, `pull`, and `getRemoteHead` without knowing whether commits travel over HTTP, WebSocket, filesystem, or carrier pigeon.

```ts
import type { SyncAdapter, PushResult, PullResult } from '@businessmaps/metaontology-nuxt'
import type { Commit } from '@businessmaps/metaontology/types/commits'

class MyCloudAdapter implements SyncAdapter {
  readonly descriptor = {
    kind: 'cloud' as const,
    label: 'My Cloud',
    icon: 'cloud' as const,
  }

  async push(
    mapId: string,
    branchId: string,
    commits: Commit[],
    baseSequence: number,
  ): Promise<PushResult> {
    // Upload commits to your backend.
    // Return { success: true, newHeadSequence } on success.
    // Return { success: false, conflict: true } on 409.
    const res = await fetch(`/api/sync/${mapId}/${branchId}`, {
      method: 'POST',
      body: JSON.stringify({ commits, baseSequence }),
    })

    if (res.status === 409) {
      return { success: false, newHeadSequence: baseSequence, conflict: true }
    }

    const data = await res.json()
    return { success: true, newHeadSequence: data.headSequence }
  }

  async pull(
    mapId: string,
    branchId: string,
    sinceSequence: number,
  ): Promise<PullResult> {
    // Fetch commits since a given sequence.
    const res = await fetch(
      `/api/sync/${mapId}/${branchId}?since=${sinceSequence}`,
    )
    const data = await res.json()
    return {
      success: true,
      commits: data.commits,
      remoteHead: data.headSequence,
    }
  }

  async getRemoteHead(mapId: string, branchId: string): Promise<number> {
    const res = await fetch(`/api/sync/${mapId}/${branchId}/head`)
    const data = await res.json()
    return data.headSequence
  }
}
```

Pass the adapter to `useSyncEngine().activate(adapter, host)`. The engine handles debouncing, retries, merge, and error classification. The adapter handles transport.

---

## Dependency injection seams

Two host interfaces keep the layer from importing app code:

**`SyncHost`** (used by `useSyncEngine`): the app provides `getRoot()`, `applyFastForward(commits)`, `applyMerged(model)`, and `onConflict(result)`. The engine drives sync state and retries; it delegates side effects to the host.

**`CrossTabHost`** (used by `useCrossTab`): the app provides `applyRemoteCommit(commit)`. When a commit arrives from another tab, the composable calls the host. The host applies the command to its local model state without re-broadcasting or re-pushing.

This pattern means the layer never imports from `app/` or `layers/bm/`. The app implements the interfaces and passes instances during activation. The boundary is enforced by `eslint-plugin-boundaries`.

---

## Directory structure

```
composables/
  useCommitLog.ts       Append-only commit log, undo/redo, checkpoint/replay
  useSyncEngine.ts      Cloud sync state machine, merge, retry
  useTripleStore.ts     Reactive triple index (Vue computed wrapper)
  useModelStore.ts      High-level map CRUD over IndexedDB
  useCrossTab.ts        BroadcastChannel cross-tab commit relay
  syncTypes.ts          SyncAdapter interface, error classification, result types
  idbConnection.ts      Singleton IndexedDB connection (owns the upgrade callback)
  idbSchema.ts          Typed DB schema (11 stores, 3 layer-owned + 8 legacy)
  idbHelpers.ts         Commit/checkpoint/branch-head CRUD, sync cursor persistence
index.ts                Barrel: re-exports @businessmaps/metaontology + all composables
nuxt.config.ts          Nuxt layer config (auto-imports composables)
```

---

## Design decisions

**Singleton per tab, not per component.** Composable state lives at module level. `useCommitLog()` returns the same object whether called from a store, a sync engine, or a UI component. Cross-tab isolation is a property of JavaScript module loading (each tab loads its own module instance), not of per-call factoring. This avoids the class of bugs where two consumers see different commit histories.

**Layer owns the IDB connection.** IndexedDB allows one upgrade callback per database version. Splitting the upgrade between the metaontology layer and the app would create a coordination problem (who runs first on a fresh install? who creates the legacy stores?). The layer creates every store the database needs; app code accesses the same connection through a thin proxy.

**Transport-agnostic sync.** The `SyncAdapter` interface is three methods: `push`, `pull`, `getRemoteHead`. Encryption, authentication, presigned URLs, compression - all internal to the adapter. The sync engine handles debouncing, retry, merge, and error classification without knowing how commits move.

**Commit-sourced, not snapshot-sourced.** Loading a map means loading the latest checkpoint and replaying commits since. The commit log is the source of truth; the model is a derived projection. This makes undo (append the inverse), sync (exchange commits), branching (fork the log), and merge (three-way merge of replayed states) all compose from the same data structure.

**Unload safety without Service Worker.** Three browser signals (`visibilitychange` hidden, `pagehide`, `beforeunload`) trigger a fire-and-forget IDB flush. The cap-triggered flush (25 pending commits) limits the worst-case data loss to 24 commits during a crash. Combined, these cover tab close, navigation, mobile backgrounding, and back/forward cache entry.

---

## License

Apache License 2.0

Copyright 2025 Business Maps
