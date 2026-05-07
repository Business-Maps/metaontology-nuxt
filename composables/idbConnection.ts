import { openDB } from 'idb'
import type { IDBPDatabase } from 'idb'
import type { BusinessMapsDB } from './idbSchema'
import { DB_NAME, DB_VERSION } from './idbSchema'

// ── Singleton IDB connection ────────────────────────────────────────────────
//
// The layer owns the IDB connection because IndexedDB only allows one upgrade
// callback per database version. Splitting the upgrade between layer and app
// would create a coordination problem (which side runs first on a fresh user?
// who creates the legacy stores?). The clean answer is that the layer owns
// the connection and the upgrade callback creates every store the database
// needs to function - model-tier stores fully typed, legacy stores typed as
// `unknown` value (see idbSchema.ts).
//
// Consuming apps access the same connection by re-exporting `getDb` and
// `closeDb` from this module via a thin proxy in their own codebase.

let _db: Promise<IDBPDatabase<BusinessMapsDB>> | null = null

export function getDb(): Promise<IDBPDatabase<BusinessMapsDB>> {
  if (!_db) {
    _db = openDB<BusinessMapsDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // Legacy stores (created by older versions of the consuming app).
        // Layer creates them with no value typing because the layer never
        // reads or writes them - they exist so the app's helpers can.
        if (!db.objectStoreNames.contains('documents')) {
          db.createObjectStore('documents', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('branches')) {
          db.createObjectStore('branches', { keyPath: 'mapId' })
        }
        if (!db.objectStoreNames.contains('history')) {
          db.createObjectStore('history', { keyPath: 'mapId' })
        }
        if (!db.objectStoreNames.contains('config')) {
          db.createObjectStore('config', { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains('tabs')) {
          db.createObjectStore('tabs', { keyPath: 'workspaceId' })
        }
        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('sync_queue')) {
          db.createObjectStore('sync_queue', {
            keyPath: 'id',
            autoIncrement: true,
          })
        }

        // Model-tier stores (commit-sourced persistence, v2).
        if (oldVersion < 2) {
          const commits = db.createObjectStore('commits', { keyPath: 'id' })
          commits.createIndex('by-map-branch-seq', ['mapId', 'branchId', 'sequence'])

          const checkpoints = db.createObjectStore('checkpoints', { keyPath: 'id' })
          checkpoints.createIndex('by-map-branch-seq', ['mapId', 'branchId', 'sequence'])

          db.createObjectStore('heads', { keyPath: ['mapId', 'branchId'] })
        }
      },
    }).catch(err => {
      console.warn('[persistence] IndexedDB unavailable - data will not persist this session:', err.message)
      throw err
    })
  }
  return _db
}

/** Close connection and reset singleton (for tests and cleanup). */
export function closeDb(): void {
  if (_db) {
    _db.then(db => db.close())
    _db = null
  }
}
