import type { H3Event } from 'h3'
import { DEFAULT_ORG_ID, DEFAULT_ORG_SLUG } from '../../shared/constants/default-org'

export interface OrgContext {
  orgId: string
  orgSlug: string
}

// Resolver returns null when a request has no tenant binding (auth-only
// routes like /register, /login, /api/auth/*). The middleware skips
// setting context.orgId in that case so those routes aren't blocked.
export type OrgContextResolver = (event: H3Event) => Promise<OrgContext | null>

const defaultResolver: OrgContextResolver = async () => ({
  orgId: DEFAULT_ORG_ID,
  orgSlug: DEFAULT_ORG_SLUG,
})

// A Nitro plugin can call `registerOrgContextResolver()` to swap in custom
// logic (e.g. parse the tenant slug from the request subdomain).
let _resolver: OrgContextResolver = defaultResolver

export function registerOrgContextResolver(resolver: OrgContextResolver): void {
  _resolver = resolver
}

export function resolveOrgContext(event: H3Event): Promise<OrgContext | null> {
  return _resolver(event)
}
