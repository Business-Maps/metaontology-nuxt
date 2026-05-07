/**
 * Reactive Triple Store - Vue wrapper around the pure triple engine.
 *
 * The pure projection, indexing, and RDF serialisation logic lives in
 * `@businessmaps/metaontology/engine/triples`. This module adds Vue reactivity via
 * `computed()` and re-exports everything for backward compatibility.
 */

import { computed, type ComputedRef } from 'vue'
import type { RootContext } from '@businessmaps/metaontology/types/context'
import type { M0State } from '@businessmaps/metaontology/types/m0'
import type { EntityClassId, PredicateId } from '@businessmaps/metaontology/meta/ontology'
import {
  type Triple,
  projectToTriples,
  buildIndexes,
  sp,
  po,
  spo,
} from '@businessmaps/metaontology/engine/triples'
import { projectM0Triples } from '@businessmaps/metaontology/engine/m0Triples'

// ── Re-export pure module for backward compatibility ────────────────────────

export {
  type Triple,
  type TripleIndexData,
  projectToTriples,
  buildIndexes,
  serialiseAsNTriples,
  serialiseAsTurtle,
  serialiseAsJsonLd,
} from '@businessmaps/metaontology/engine/triples'

// ── Reactive index type ─────────────────────────────────────────────────────

export interface TripleIndex {
  /** All triples in the store. */
  triples: ComputedRef<Triple[]>
  /** All triples where subject === id. */
  bySubject: (id: string) => Triple[]
  /** All triples where predicate === p. */
  byPredicate: (p: string) => Triple[]
  /** All triples where object === id. */
  byObject: (id: string) => Triple[]
  /** All triples where subject === s AND predicate === p. */
  bySP: (s: string, p: string) => Triple[]
  /** All triples where predicate === p AND object === o. */
  byPO: (p: string, o: string) => Triple[]
  /** Check if a specific triple exists. */
  has: (s: string, p: string, o: string) => boolean
  /** Object IDs where subject === s for predicate p (convenience). */
  objectIds: (s: string, p: PredicateId) => string[]
  /** Subject IDs where object === o for predicate p (convenience). */
  subjectIds: (o: string, p: PredicateId) => string[]
  /** First object ID (for 1:1 relationships). */
  firstObjectId: (s: string, p: PredicateId) => string | undefined
  /** First subject ID (for reverse 1:1 lookups). */
  firstSubjectId: (o: string, p: PredicateId) => string | undefined
  /** Entity type classification: entityId → EntityClassId. */
  entityType: (id: string) => EntityClassId | undefined
}

// ── Factory ──────────────────────────────────────────────────────────────────

const EMPTY: Triple[] = []

/**
 * Create a reactive triple index over a RootContext and optional M0State.
 * The getRoot function should return a reactive reference (e.g. `() => store.root`).
 * The optional getM0 function provides M0 state for cross-tier triple projection.
 * The entire index rebuilds reactively when either root or m0 changes.
 */
export function createTripleIndex(
  getRoot: () => Readonly<RootContext>,
  getM0?: () => M0State | undefined,
): TripleIndex {
  const triples = computed(() => {
    const m1 = projectToTriples(getRoot())
    const m0State = getM0?.()
    if (!m0State) return m1
    const m0 = projectM0Triples(m0State, getRoot())
    return [...m1, ...m0]
  })
  const indexes = computed(() => buildIndexes(triples.value))

  function bySubject(id: string): Triple[] {
    return indexes.value.byS.get(id) ?? EMPTY
  }
  function byPredicate(p: string): Triple[] {
    return indexes.value.byP.get(p) ?? EMPTY
  }
  function byObject(id: string): Triple[] {
    return indexes.value.byO.get(id) ?? EMPTY
  }
  function bySP(s: string, p: string): Triple[] {
    return indexes.value.bySP.get(sp(s, p)) ?? EMPTY
  }
  function byPO(p: string, o: string): Triple[] {
    return indexes.value.byPO.get(po(p, o)) ?? EMPTY
  }
  function has(s: string, p: string, o: string): boolean {
    return indexes.value.bySPO.has(spo(s, p, o))
  }
  function objectIds(s: string, p: PredicateId): string[] {
    return bySP(s, p).map(t => t.object)
  }
  function subjectIds(o: string, p: PredicateId): string[] {
    return byPO(p, o).map(t => t.subject)
  }
  function firstObjectId(s: string, p: PredicateId): string | undefined {
    return bySP(s, p)[0]?.object
  }
  function firstSubjectId(o: string, p: PredicateId): string | undefined {
    return byPO(p, o)[0]?.subject
  }
  function entityType(id: string): EntityClassId | undefined {
    return indexes.value.typeOf.get(id) as EntityClassId | undefined
  }

  return {
    triples,
    bySubject,
    byPredicate,
    byObject,
    bySP,
    byPO,
    has,
    objectIds,
    subjectIds,
    firstObjectId,
    firstSubjectId,
    entityType,
  }
}
