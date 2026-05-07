import type { IDBCommitRecord, IDBCheckpointRecord, IDBBranchHeadRecord } from './idbSchema'
import { getDb } from './idbConnection'

// ── Commit store helpers ──────────────────────────────────────────────

export async function saveCommits(commits: IDBCommitRecord[]): Promise<void> {
  if (commits.length === 0) return
  const db = await getDb()
  const tx = db.transaction('commits', 'readwrite')
  for (const commit of commits) {
    await tx.store.put(commit)
  }
  await tx.done
}

export async function loadCommitsSince(
  mapId: string,
  branchId: string,
  sinceSequence: number,
): Promise<IDBCommitRecord[]> {
  const db = await getDb()
  const index = db.transaction('commits', 'readonly').store.index('by-map-branch-seq')
  const range = IDBKeyRange.bound(
    [mapId, branchId, sinceSequence + 1],
    [mapId, branchId, Number.MAX_SAFE_INTEGER],
  )
  return index.getAll(range)
}

// ── Checkpoint store helpers ─────────────────────────────────────────

export async function saveCheckpoint(checkpoint: IDBCheckpointRecord): Promise<void> {
  const db = await getDb()
  await db.put('checkpoints', checkpoint)
}

export async function loadLatestCheckpoint(
  mapId: string,
  branchId: string,
): Promise<IDBCheckpointRecord | null> {
  const db = await getDb()
  const index = db.transaction('checkpoints', 'readonly').store.index('by-map-branch-seq')
  const range = IDBKeyRange.bound(
    [mapId, branchId, 0],
    [mapId, branchId, Number.MAX_SAFE_INTEGER],
  )
  // Get all and return the last one (highest sequence)
  const all = await index.getAll(range)
  return all.length > 0 ? all[all.length - 1]! : null
}

export async function pruneOldCheckpoints(
  mapId: string,
  branchId: string,
  keepCount: number,
): Promise<void> {
  const db = await getDb()
  const index = db.transaction('checkpoints', 'readwrite').store.index('by-map-branch-seq')
  const range = IDBKeyRange.bound(
    [mapId, branchId, 0],
    [mapId, branchId, Number.MAX_SAFE_INTEGER],
  )
  const all = await index.getAll(range)
  if (all.length <= keepCount) return

  const tx = db.transaction('checkpoints', 'readwrite')
  const toDelete = all.slice(0, all.length - keepCount)
  for (const cp of toDelete) {
    await tx.store.delete(cp.id)
  }
  await tx.done
}

// ── Branch head store helpers ────────────────────────────────────────

export async function saveBranchHead(head: IDBBranchHeadRecord): Promise<void> {
  const db = await getDb()
  await db.put('heads', head)
}

// ── Sync cursor persistence ───────────────────────────────────────────
//
// The sync engine's `lastSyncedSequence` was originally ephemeral - held
// only in the engine singleton and reset to 0 on every fresh page load.
// That caused two user-visible failures:
//
//  1. After any refresh, the engine re-pushed every local commit starting
//     from sequence 0, which 409'd against whatever the server already had.
//  2. Navigating back then forward during an AI tool run could leave the
//     engine thinking "0 commits synced" while the server had received
//     200+ of them via `sync.schedulePush()` firing off `commits.value`
//     before the debounced IDB flush caught up.
//
// We now persist the cursor alongside the branch head in the `config`
// store under a keyed entry so it survives navigation, refresh, and tab
// close. The value is a small JSON object keyed by `${mapId}:${branchId}`.
//
// `config` is typed as `unknown` at the layer (it's an app-owned legacy
// store). We read/write via cast. If a future schema lifts it into the
// typed layer surface, these helpers become the migration site.

// The `config` store has `keyPath: 'key'` (see idbConnection.ts) so records
// must carry the primary key inline as a `key` field. The value is a small
// JSON object keyed by `sync-cursor:${mapId}:${branchId}`.
interface SyncCursorRecord {
  key: string
  mapId: string
  branchId: string
  lastSyncedSequence: number
  updatedAt: string
}

function syncCursorKey(mapId: string, branchId: string): string {
  return `sync-cursor:${mapId}:${branchId}`
}

export async function saveSyncCursor(
  mapId: string,
  branchId: string,
  lastSyncedSequence: number,
): Promise<void> {
  const db = await getDb()
  const record: SyncCursorRecord = {
    key: syncCursorKey(mapId, branchId),
    mapId,
    branchId,
    lastSyncedSequence,
    updatedAt: new Date().toISOString(),
  }
  // The `config` store is typed as `unknown` in the layer schema - the
  // double-cast tells TypeScript we know what we're doing. The key is
  // pulled from `record.key` via the store's keyPath.
  await db.put('config', record as unknown as never)
}

export async function loadSyncCursor(
  mapId: string,
  branchId: string,
): Promise<number> {
  const db = await getDb()
  const record = (await db.get('config', syncCursorKey(mapId, branchId))) as
    | SyncCursorRecord
    | undefined
  return record?.lastSyncedSequence ?? 0
}

export async function clearSyncCursor(
  mapId: string,
  branchId: string,
): Promise<void> {
  const db = await getDb()
  await db.delete('config', syncCursorKey(mapId, branchId))
}

// ── Storage quota helpers ─────────────────────────────────────────────

export async function checkStorageQuota(): Promise<{
  usage: number
  quota: number
  percentUsed: number
} | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota, percentUsed: quota > 0 ? (usage / quota) * 100 : 0 }
}
