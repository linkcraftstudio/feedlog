// FeedLog access-control statement + role dictionary. Shared by:
//   - server: organization plugin (auth.api.hasPermission)
//   - client: organizationClient (checkRolePermission, sync)
//
// Single custom token `feedlog:moderate`. Tier map:
//   - anyone in the org (any role)  → `requireOrgMember(event)`
//   - moderators (manager + owner)  → `requireOrgPermission({ feedlog: ['moderate'] })`
//   - org-owner-only actions        → covered by better-auth's built-in
//                                     `organization:*` / `member:*` actions
//                                     via ownerAc.
//
// `:own` vs `:any` (who can edit their own row vs anyone's row) is checked
// inline in handlers — load the row, compare `row.authorId` to the caller's
// user id, escalate to moderate when not the author.

import { createAccessControl } from 'better-auth/plugins/access'
import {
  defaultStatements as orgDefaultStatements,
  adminAc,
  ownerAc,
  memberAc,
} from 'better-auth/plugins/organization/access'

export const baseFeedlogStatement = {
  feedlog: ['moderate'],
} as const

// Merge with better-auth organization plugin's built-in statement so
// invitation / member / organization actions share the same `ac`.
export const baseStatement = {
  ...orgDefaultStatements,
  ...baseFeedlogStatement,
} as const

export const ac = createAccessControl(baseStatement)

const moderatorPerms = {
  feedlog: ['moderate'],
} as const

export const baseRolePermissions = {
  owner: {
    ...ownerAc.statements,
    ...moderatorPerms,
  },
  manager: {
    ...adminAc.statements,
    ...moderatorPerms,
  },
  contributor: {
    ...memberAc.statements,
  },
} as const

export const owner = ac.newRole(baseRolePermissions.owner)
export const manager = ac.newRole(baseRolePermissions.manager)
export const contributor = ac.newRole(baseRolePermissions.contributor)

export const roles = { owner, manager, contributor }

export type RoleName = keyof typeof roles
export type FeedlogStatement = typeof baseStatement
