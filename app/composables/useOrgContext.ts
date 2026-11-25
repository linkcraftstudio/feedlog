import { DEFAULT_ORG_ID, DEFAULT_ORG_SLUG } from '~~/shared/constants/default-org'

// Active org context for the current request. Defaults to the single
// default-org. When `rootDomain` is configured, parses the tenant slug
// from the request host (SSR via useRequestURL, browser via
// window.location) and resolves orgId / role from the session's orgList.
export interface ClientOrgContext {
  orgId: string
  orgSlug: string
  // Current user's role inside this org, if any (driven by session.orgList).
  role: 'owner' | 'manager' | 'contributor' | null
  // Suspended: still a member, but limited to a few pages.
  suspended: boolean
  // 'manual' when an owner or manager suspended the member; otherwise a deployment-defined value.
  suspendedReason: string | null
}

interface OrgListRow { orgId: string, slug: string, role: string, suspended?: boolean, suspendedReason?: string | null }

function parseTenantSlug(host: string, rootDomain: string, authDomainHost: string): string | null {
  const bare = host.toLowerCase().split(':')[0] ?? ''
  if (!bare || bare === rootDomain || bare === authDomainHost) return null
  const suffix = `.${rootDomain}`
  if (!bare.endsWith(suffix)) return null
  const slug = bare.slice(0, -suffix.length)
  return !slug || slug.includes('.') ? null : slug
}

export function useOrgContext(): ComputedRef<ClientOrgContext> {
  const { data: session } = useAuthSession()
  const config = useRuntimeConfig()
  const rootDomain = (config.public.rootDomain ?? '') as string
  const authDomain = (config.public.authDomain ?? '') as string
  const authDomainHost = authDomain.replace(/^https?:\/\//, '').replace(/:\d+$/, '')

  // SSR: read host from request. Browser: read from window.location.
  const requestURL = import.meta.server ? useRequestURL() : null

  return computed(() => {
    const list = (session.value as { orgList?: OrgListRow[] } | null | undefined)?.orgList ?? []

    // Open-source: rootDomain unset → single-tenant.
    if (!rootDomain) {
      const match = list.find(o => o.orgId === DEFAULT_ORG_ID)
      return { orgId: DEFAULT_ORG_ID, orgSlug: DEFAULT_ORG_SLUG, role: (match?.role as ClientOrgContext['role']) ?? null, suspended: match?.suspended === true, suspendedReason: match?.suspendedReason ?? null }
    }

    const host = import.meta.server
      ? requestURL?.host ?? ''
      : (typeof window !== 'undefined' ? window.location.host : '')
    const slug = parseTenantSlug(host, rootDomain, authDomainHost)
    if (!slug) {
      // Auth / root host — no tenant binding. Surface the default-org so
      // unrelated UI bits don't crash, but role is null.
      return { orgId: DEFAULT_ORG_ID, orgSlug: DEFAULT_ORG_SLUG, role: null, suspended: false, suspendedReason: null }
    }
    const match = list.find(o => o.slug === slug)
    return {
      orgId: match?.orgId ?? slug,
      orgSlug: match?.slug ?? slug,
      role: (match?.role as ClientOrgContext['role']) ?? null,
      suspended: match?.suspended === true,
      suspendedReason: match?.suspendedReason ?? null,
    }
  })
}
