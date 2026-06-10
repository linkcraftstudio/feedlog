import type { ResolvedBranding } from '#layers/feedlog/shared/utils/branding'
import { resolveBranding } from '#layers/feedlog/shared/utils/branding'

export interface PortalOrg {
  name: string // org name, or 'FeedLog' for the default org
  logo: string | null
  isDefault: boolean // unconfigured default org → generic share-card copy
  branding: ResolvedBranding
}

// Portal identity for share-card meta. Populated per-request by
// plugins/portal-org.server.ts and hydrated via payload; generic default until then.
export function usePortalOrg() {
  return useState<PortalOrg>('portal-org', () => ({
    name: 'FeedLog',
    logo: null,
    isDefault: true,
    branding: resolveBranding(null),
  }))
}
