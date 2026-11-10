import { DEFAULT_ORG_NAME, DEFAULT_ORG_SLUG } from '../../shared/constants/default-org'

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    'feedlog:email:brand': (brand: { name?: string }) => void | Promise<void>
  }
}

// The site-level name for account emails (sign-up, password, invitations,
// notifications): the default organization's name, or none for the unnamed
// default organization, and those emails keep the FeedLog name. Emails about
// one organization's conversation pass that organization's name instead.
// An app that builds FeedLog as a layer changes the name in a server plugin:
// nitroApp.hooks.hook('feedlog:email:brand', brand => { brand.name = 'Acme' })
export async function emailBrandName(): Promise<string | undefined> {
  const brand: { name?: string } = {}
  // Outside the server (a script or a test) or with no database, a step finds nothing.
  try {
    const name = (await getOrgInfo(DEFAULT_ORG_SLUG))?.name
    if (name && name !== DEFAULT_ORG_NAME) brand.name = name
  }
  catch { /* no organization name */ }
  try { await useNitroApp().hooks.callHook('feedlog:email:brand', brand) }
  catch { /* no hook */ }
  return brand.name
}
