// Public entrypoint for the Nuxt integration package.
//
// - Nuxt auto-imports composables from ./composables when this package is used
//   as a layer via `extends: ['@businessmaps/metaontology-nuxt']`.
// - This barrel is for explicit imports by consumers (and for non-Nuxt tools
//   that want the same dependency).

export * from '@businessmaps/metaontology'
export * from './composables/syncTypes'
export * from './composables/useCommitLog'
export * from './composables/useCrossTab'
export * from './composables/useModelStore'
export * from './composables/useSyncEngine'
export * from './composables/useTripleStore'

