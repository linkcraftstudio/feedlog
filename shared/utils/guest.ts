import { z } from 'zod/v4'
import { type OrgMetadataInput, parseOrgMetadata } from './branding'

// Guest access = the three things a visitor may do without signing in. Stored
// under organization.metadata.guest rather than in its own table: three booleans
// an owner flips a handful of times in a workspace's life, on a row the org
// cache already loads for every request.

export const guestAccessSchema = z.object({
  allowPost: z.boolean().optional(),
  allowVote: z.boolean().optional(),
  allowComment: z.boolean().optional(),
})

export type GuestAccess = z.infer<typeof guestAccessSchema>

export interface ResolvedGuestAccess {
  allowPost: boolean
  allowVote: boolean
  allowComment: boolean
}

export type GuestAction = keyof ResolvedGuestAccess

// Everything off by default, so upgrading an existing install never silently
// opens the portal to unauthenticated writes.
export const GUEST_ACCESS_DEFAULTS: ResolvedGuestAccess = {
  allowPost: false,
  allowVote: false,
  allowComment: false,
}

export function parseGuestAccess(metadata: OrgMetadataInput): GuestAccess {
  const result = guestAccessSchema.safeParse(parseOrgMetadata(metadata).guest)
  return result.success ? result.data : {}
}

export function resolveGuestAccess(metadata: OrgMetadataInput): ResolvedGuestAccess {
  const parsed = parseGuestAccess(metadata)
  return {
    allowPost: parsed.allowPost ?? GUEST_ACCESS_DEFAULTS.allowPost,
    allowVote: parsed.allowVote ?? GUEST_ACCESS_DEFAULTS.allowVote,
    allowComment: parsed.allowComment ?? GUEST_ACCESS_DEFAULTS.allowComment,
  }
}

export function mergeGuestAccessMetadata(
  metadata: OrgMetadataInput,
  access: GuestAccess,
): Record<string, unknown> {
  return {
    ...parseOrgMetadata(metadata),
    guest: guestAccessSchema.parse(access),
  }
}

// With all three off there is nothing a guest identity could be used for, so
// the mint endpoint refuses to create one at all.
export function guestAccessEnabled(access: ResolvedGuestAccess): boolean {
  return access.allowPost || access.allowVote || access.allowComment
}

// Where the browser keeps the guest's raw session token. Shared by the portal and
// the embedded widget: in a same-site embed the two surfaces are then one guest
// instead of two. When the browser partitions iframe storage they simply see
// different buckets, which costs nothing.
export const GUEST_TOKEN_STORAGE_KEY = 'feedlog:guest:token'

// Placeholder address for guest rows. `.invalid` is reserved by RFC 2606 and can
// never be registered, so mail aimed at a guest can't reach a real inbox.
export const GUEST_EMAIL_DOMAIN = 'feedlog.invalid'

export function isGuestEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${GUEST_EMAIL_DOMAIN}`)
}
