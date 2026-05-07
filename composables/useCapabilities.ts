/**
 * useCapabilities — reactive composable that derives the current user's
 * capabilities from the model's Identity + Grant graph.
 *
 * Reads from the store's reactive root and the auth store's userId.
 * Every time the model changes (e.g., a grant is added/removed via sync),
 * the capabilities recompute automatically.
 *
 * This composable is the single source of truth for all UI visibility
 * decisions — replaces ad-hoc `isOwner` / `role === 'editor'` checks.
 */

import { computed, type Ref, type ComputedRef } from 'vue'
import type { RootContext } from '@businessmaps/metaontology/types/context'
import {
  evaluateGrants,
  hasCapability,
  listIdentities,
  type Capability,
  type ResolvedGrants,
} from '@businessmaps/metaontology/engine/grants'

export interface UseCapabilitiesReturn {
  /** Full resolved grants for the current user. */
  resolved: ComputedRef<ResolvedGrants | null>
  /** The effective capability level (owner > editor > viewer). */
  capability: ComputedRef<Capability>
  /** True if the current user is the map owner. */
  isOwner: ComputedRef<boolean>
  /** True if the current user has at least editor capability. */
  canEdit: ComputedRef<boolean>
  /** True if the current user can invite collaborators (owner or editor). */
  canInvite: ComputedRef<boolean>
  /** True if the current user can revoke access (owner only). */
  canRevokeAccess: ComputedRef<boolean>
  /** True if the current user can change other users' roles (owner only). */
  canChangeRoles: ComputedRef<boolean>
  /** True if the current user can delete the map (owner only). */
  canDeleteMap: ComputedRef<boolean>
  /** All identities in the model with their resolved capabilities. */
  allIdentities: ComputedRef<ResolvedGrants[]>
}

export function useCapabilities(
  root: Ref<RootContext>,
  userId: Ref<string | undefined>,
): UseCapabilitiesReturn {
  const resolved = computed<ResolvedGrants | null>(() => {
    if (!userId.value) return null
    return evaluateGrants(root.value, userId.value)
  })

  const capability = computed<Capability>(
    () => resolved.value?.capability ?? 'viewer',
  )

  const isOwner = computed(() => capability.value === 'owner')
  const canEdit = computed(() =>
    userId.value ? hasCapability(root.value, userId.value, 'editor') : false,
  )
  const canInvite = computed(() => canEdit.value)
  const canRevokeAccess = computed(() => isOwner.value)
  const canChangeRoles = computed(() => isOwner.value)
  const canDeleteMap = computed(() => isOwner.value)

  const allIdentities = computed(() => listIdentities(root.value))

  return {
    resolved,
    capability,
    isOwner,
    canEdit,
    canInvite,
    canRevokeAccess,
    canChangeRoles,
    canDeleteMap,
    allIdentities,
  }
}
