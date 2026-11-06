import { DEFAULT_ORG_NAME, DEFAULT_ORG_SLUG } from '../../shared/constants/default-org'

// The name emails go out under: the organization's own name. The unnamed
// default organization has none, and emails keep the FeedLog name.
export async function emailBrandName(): Promise<string | undefined> {
  try {
    const name = (await getOrgInfo(DEFAULT_ORG_SLUG))?.name
    return name && name !== DEFAULT_ORG_NAME ? name : undefined
  }
  catch {
    // No lookup (a script or a test outside the server) or no database: no brand name.
    return undefined
  }
}
