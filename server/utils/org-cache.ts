import { eq } from 'drizzle-orm'
import { db } from '../db'
import { organization } from '../db/schemas'
import { DEFAULT_ORG_ID, DEFAULT_ORG_SLUG } from '../../shared/constants/default-org'

export interface OrgInfo {
  id: string
  slug: string
  name: string
  logo: string | null
  metadata: string | null
}

export interface OrgCacheBackend {
  get: (slug: string) => Promise<OrgInfo | null>
  invalidate: (slug: string) => Promise<void>
}

const defaultBackend: OrgCacheBackend = {
  async get(slug) {
    if (slug !== DEFAULT_ORG_SLUG) return null
    const rows = await db
      .select({
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
        logo: organization.logo,
        metadata: organization.metadata,
      })
      .from(organization)
      .where(eq(organization.id, DEFAULT_ORG_ID))
      .limit(1)
    return rows[0] ?? null
  },
  async invalidate() { /* no-op — default backend reads live from DB */ },
}

let _backend: OrgCacheBackend = defaultBackend

export function registerOrgCacheBackend(backend: OrgCacheBackend): void {
  _backend = backend
}

export function getOrgInfo(slug: string): Promise<OrgInfo | null> {
  return _backend.get(slug)
}

export function invalidateOrgInfo(slug: string): Promise<void> {
  return _backend.invalidate(slug)
}
