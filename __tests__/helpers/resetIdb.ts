// Shared test helper: drop every IDB database and close any cached
// connection so a fresh test starts from a clean slate.

import { closeDb } from '../../composables/idbConnection'

export async function resetIdb(): Promise<void> {
  closeDb()
  if (indexedDB.databases) {
    const dbs = await indexedDB.databases()
    await Promise.all(dbs.map(db => db.name ? new Promise<void>(resolve => {
      const req = indexedDB.deleteDatabase(db.name!)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    }) : Promise.resolve()))
  }
}

