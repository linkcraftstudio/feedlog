import { authClient } from '~/lib/auth-client'

type ResourceType = 'post' | 'comment'

// Frontend permission helpers. Mirrors server-side gates:
//   - any org member  → `requireOrgMember`        (no client check needed)
//   - moderator       → `requireOrgPermission({ feedlog: ['moderate'] })`
//
// Ownership is a row-level check: `authorId === session.user.id`. Edit/delete
// is allowed when the caller is the author OR a moderator. Comments follow
// the same rule.
export function usePermission(authorId: Ref<string | undefined> | ComputedRef<string | undefined>, type: ResourceType) {
  const { data: session } = useAuthSession()
  const ctx = useOrgContext()

  const userId = computed(() => session.value?.user?.id)
  const role = computed(() => ctx.value.role)
  const isOrgOwner = computed(() => role.value === 'owner')
  const isOwner = computed(() => !!authorId.value && userId.value === authorId.value)

  const canModerate = computed(() => {
    if (!role.value) return false
    return authClient.organization.checkRolePermission({
      role: role.value,
      permissions: { feedlog: ['moderate'] } as Record<string, string[]>,
    }) === true
  })

  // Kept as an alias for callers that still read `isOrgManager`. Semantically
  // identical to `canModerate` — both ask "can this role moderate FeedLog
  // content?". The role-string check (owner|manager) was a stale proxy.
  const isOrgManager = canModerate

  const canEdit = computed(() => {
    if (type === 'post') return isOwner.value || canModerate.value
    // Product rule: comments can only be edited by their author. Moderators
    // can't rewrite someone else's comment — they can only delete it.
    return isOwner.value
  })

  const canDelete = computed(() => isOwner.value || canModerate.value)

  const showMenu = computed(() => canEdit.value || canDelete.value)

  return { isOrgManager, isOrgOwner, isOwner, canModerate, canEdit, canDelete, showMenu }
}
