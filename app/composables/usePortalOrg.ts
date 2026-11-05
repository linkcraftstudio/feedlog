import type { ResolvedBranding } from '#layers/feedlog/shared/utils/branding'
import { resolveBranding } from '#layers/feedlog/shared/utils/branding'
import type { ResolvedGuestAccess } from '#layers/feedlog/shared/utils/guest'
import { resolveGuestAccess } from '#layers/feedlog/shared/utils/guest'
import type { ResolvedPortalModules } from '#layers/feedlog/shared/utils/portal-modules'
import { resolvePortalModules } from '#layers/feedlog/shared/utils/portal-modules'
import type { ExternalAuthUrls } from '#layers/feedlog/shared/utils/external-auth'
import { resolvePortalAuthConfig } from '#layers/feedlog/shared/utils/external-auth'

export interface PortalOrg {
  name: string // org name, or 'FeedLog' for the default org
  logo: string | null
  isDefault: boolean // unconfigured default org → generic share-card copy
  branding: ResolvedBranding
  guest: ResolvedGuestAccess
  modules: ResolvedPortalModules
  auth: ExternalAuthUrls
}

// Portal identity for share-card meta. Populated per-request by
// plugins/portal-org.server.ts and hydrated via payload; generic default until then.
export function usePortalOrg() {
  return useState<PortalOrg>('portal-org', () => ({
    name: 'FeedLog',
    logo: null,
    isDefault: true,
    branding: resolveBranding(null),
    guest: resolveGuestAccess(null),
    modules: resolvePortalModules(null),
    auth: resolvePortalAuthConfig(null),
  }))
}
