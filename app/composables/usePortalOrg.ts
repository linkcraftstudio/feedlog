export interface PortalOrg {
  name: string // org name, or 'FeedLog' for the default org
  isDefault: boolean // unconfigured default org → generic share-card copy
}

// Portal identity for share-card meta. Populated per-request by
// plugins/portal-org.server.ts and hydrated via payload; generic default until then.
export function usePortalOrg() {
  return useState<PortalOrg>('portal-org', () => ({ name: 'FeedLog', isDefault: true }))
}
