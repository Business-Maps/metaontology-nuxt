import type { DBSchema } from 'idb'
import type { RootContext } from '@businessmaps/metaontology/types/context'
import type { DispatchableCommand } from '@businessmaps/metaontology/types/commands'
import type { M0State } from '@businessmaps/metaontology/types/m0'

// ── Model-tier records (layer-owned persistence) ────────────────────────────
//
// These three records are the model-tier persistence layer. They live in the
// ontology layer because the engine owns commit-sourced state derivation.
// The consuming app's view-state records (documents, branches, history, tabs,
// conversations, blobs, sync_queue) are typed in the app's own schema file.
// The layer's BusinessMapsDB schema below names those
// stores so the upgrade callback can create them, but types their values as
// `unknown` - the layer never reads or writes them directly.

export interface IDBCommitRecord {
  id: string
  mapId: string
  branchId: string
  sequence: number
  command: DispatchableCommand
  inverse: DispatchableCommand
  timestamp: string
  deviceId: string
  parentId: string | null
}

export interface IDBCheckpointRecord {
  id: string
  mapId: string
  branchId: string
  commitId: string
  sequence: number
  model: RootContext
  m0?: M0State
  timestamp: string
}

export interface IDBBranchHeadRecord {
  mapId: string
  branchId: string
  name: string
  headCommitId: string
  forkPointCommitId: string
  parentBranchId: string
  createdAt: string
}

// ── BusinessMapsDB ──────────────────────────────────────────────────────────
//
// The full IDB schema for the `businessmaps` database. The layer owns the
// connection (because IDB only allows one upgrade callback per DB version),
// so the layer's schema must name every store. Legacy stores have their value
// types narrowed to `unknown` - the layer doesn't import app types. The
// consuming app re-exports a typed view of the same database in its own
// schema file for its own helpers.

export interface BusinessMapsDB extends DBSchema {
  // ── Model-tier (layer-owned, fully typed) ──
  commits: {
    key: string
    value: IDBCommitRecord
    indexes: { 'by-map-branch-seq': [string, string, number] }
  }
  checkpoints: {
    key: string
    value: IDBCheckpointRecord
    indexes: { 'by-map-branch-seq': [string, string, number] }
  }
  heads: {
    key: [string, string]  // [mapId, branchId]
    value: IDBBranchHeadRecord
  }

  // ── Legacy / canvas-tier (app-owned, narrowed to unknown at the layer) ──
  documents: { key: string; value: unknown }
  branches: { key: string; value: unknown }
  history: { key: string; value: unknown }
  config: { key: string; value: unknown }
  tabs: { key: string; value: unknown }
  conversations: { key: string; value: unknown }
  blobs: { key: string; value: unknown }
  sync_queue: {
    key: number
    value: unknown
    autoIncrement: true
  }
}

export const DB_NAME = 'businessmaps'
export const DB_VERSION = 3

export const MODEL_STORE_NAMES = ['commits', 'checkpoints', 'heads'] as const
