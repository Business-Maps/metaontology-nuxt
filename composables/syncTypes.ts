import type { Commit } from '@businessmaps/metaontology/types/commits'

// ── Sync target descriptor ──────────────────────────────────────────────────
// A named destination where commits are pushed. Maps without auth have no
// target (local only). The target is the declared identity of sync, not an
// implementation detail.

export type SyncTargetKind = 'cloud' | 'filesystem'

export interface SyncTargetDescriptor {
  kind: SyncTargetKind
  label: string          // "Business Maps Cloud", "~/projects/mymap"
  icon: 'cloud' | 'folder'
}

// ── Sync status ─────────────────────────────────────────────────────────────

export type SyncStatus = 'idle' | 'pushing' | 'pulling' | 'conflict' | 'error'

// ── Error categories ────────────────────────────────────────────────────────
// Classification of sync failures so the UI can show a friendly message and
// the engine can adjust its retry/log behavior. The raw error string is still
// available via `lastError` for advanced views; `errorCategory` drives default
// UX. Add new categories here as new failure modes appear in the wild.

export type SyncErrorCategory =
  | 'network'    // generic network failure (DNS, fetch failed, ECONNREFUSED, offline)
  | 'cors'       // CORS preflight rejection - usually a misconfigured bucket
  | 'auth'       // 401/403 - token expired, no permission
  | 'conflict'   // 409 - remote has newer changes (covered by status='conflict' too)
  | 'server'     // 5xx - remote service is broken
  | 'crypto'     // missing/invalid encryption key
  | 'unknown'    // doesn't match any of the above

/**
 * Classify a thrown error or error message into a SyncErrorCategory.
 *
 * Used by both `useSyncEngine` (to drive log throttling and category-aware
 * retry decisions) and the UI (to render friendly status text). Pure: takes
 * any value, returns one category. Defensive against unknown error shapes.
 */
export function classifySyncError(e: unknown): SyncErrorCategory {
  if (!e) return 'unknown'

  // Status-code-based classification - most reliable signal when present.
  const status = (e as { statusCode?: number; status?: number }).statusCode
    ?? (e as { statusCode?: number; status?: number }).status
  if (status === 401 || status === 403) return 'auth'
  if (status === 409) return 'conflict'
  if (status && status >= 500 && status < 600) return 'server'

  const message = e instanceof Error ? e.message : String(e)
  const lower = message.toLowerCase()

  // CORS-specific patterns. Browsers report CORS failures as "fetch failed"
  // or "Failed to fetch" with no status code (preflight blocked). The most
  // reliable signal is `ERR_FAILED` in the message or a fetch failure with
  // no status against a known cross-origin endpoint.
  if (lower.includes('cors')) return 'cors'
  if (lower.includes('err_failed') && lower.includes('fetch')) return 'cors'

  // Network-down / unreachable patterns. The two distinct patterns here
  // come from different runtimes:
  //  - Browser fetch: "Failed to fetch", "NetworkError", and the bare
  //    "net::ERR_FAILED" Chrome surfaces when the OS-level connection
  //    cannot complete (also surfaces for opaque CORS preflight failures
  //    where the browser refuses to expose the response to JS).
  //  - Node fetch: ECONNREFUSED, ENOTFOUND, ETIMEDOUT.
  if (lower.includes('failed to fetch')) return 'network'
  if (lower.includes('networkerror')) return 'network'
  if (lower.includes('err_failed')) return 'network'
  if (lower.includes('econnrefused')) return 'network'
  if (lower.includes('enotfound')) return 'network'
  if (lower.includes('etimedout')) return 'network'
  if (lower.includes('offline')) return 'network'

  // Crypto/auth-key cases (the adapter returns these as Error('No encryption key')).
  if (lower.includes('encryption key')) return 'crypto'

  return 'unknown'
}

/**
 * Map a SyncErrorCategory to a short, user-facing status string. Used in the
 * branch manager dropdown and the sync indicator. Keep these terse - the
 * dropdown is narrow, and the user wants to know "is sync working?" first,
 * "why not?" second.
 */
export function friendlySyncErrorMessage(category: SyncErrorCategory): string {
  switch (category) {
    case 'network':  return 'Cloud unreachable - working locally'
    case 'cors':     return 'Cloud sync misconfigured (CORS)'
    case 'auth':     return 'Sign-in expired'
    case 'conflict': return 'Remote has newer changes - pull required'
    case 'server':   return 'Cloud sync temporarily unavailable'
    case 'crypto':   return 'Encryption key missing'
    case 'unknown':  return 'Sync error'
  }
}

// ── Adapter result types ────────────────────────────────────────────────────

export interface PushResult {
  success: boolean
  newHeadSequence: number
  error?: string
  conflict?: boolean      // 409 - remote has newer changes
}

export interface PullResult {
  success: boolean
  commits: Commit[]
  remoteHead: number
  error?: string
}

// ── Sync adapter interface ──────────────────────────────────────────────────
// Transport-agnostic contract for pushing/pulling commits to a sync target.
// Encryption, HTTP, presigned URLs, filesystem writes - all internal to the
// adapter. The sync engine doesn't care how commits move, only that they do.

export interface SyncAdapter {
  readonly descriptor: SyncTargetDescriptor

  /** Push local commits to the remote target. */
  push(
    mapId: string,
    branchId: string,
    commits: Commit[],
    baseSequence: number,
  ): Promise<PushResult>

  /** Pull remote commits since a given sequence. */
  pull(
    mapId: string,
    branchId: string,
    sinceSequence: number,
  ): Promise<PullResult>

  /** Get the current remote head sequence for optimistic locking. */
  getRemoteHead(
    mapId: string,
    branchId: string,
  ): Promise<number>
}
