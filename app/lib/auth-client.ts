import { createAuthClient } from 'better-auth/vue'
import { adminClient, customSessionClient, organizationClient } from 'better-auth/client/plugins'
import { ac, contributor, manager, owner } from '~~/shared/auth/permissions'
import type { auth } from '~~/server/utils/better-auth'

// Mirror server plugins so client-side helpers (checkRolePermission, etc.)
// share the same access-control statement + role table. customSessionClient
// threads the server's customSession() shape (incl. orgList) into the typed
// session payload.
export const authClient = createAuthClient({
  plugins: [
    adminClient(),
    organizationClient({ ac, roles: { owner, manager, contributor } }),
    customSessionClient<typeof auth>(),
  ],
})
