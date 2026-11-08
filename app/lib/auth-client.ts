import { createAuthClient } from 'better-auth/vue'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { adminClient, customSessionClient, organizationClient } from 'better-auth/client/plugins'
import { ac, contributor, manager, owner } from '~~/shared/auth/permissions'
import { notifyPermissionDenied } from '#layers/feedlog/app/utils/permission-error'
import { promptLocalAuthIfRequired } from '~/composables/useLoginModal'
import type { auth } from '~~/server/utils/better-auth'

// Mirror server plugins so client-side helpers (checkRolePermission, etc.)
// share the same access-control statement + role table. customSessionClient
// threads the server's customSession() shape (incl. orgList) into the typed
// session payload.
export const authClient = createAuthClient({
  plugins: [
    oauthProviderClient(),
    adminClient(),
    organizationClient({ ac, roles: { owner, manager, contributor } }),
    customSessionClient<typeof auth>(),
  ],
  fetchOptions: {
    // Settings pages call better-auth directly, so refusals surface here rather
    // than through useApiFetch. Read `error`, not `response`: better-fetch hands
    // back a plain web Response and spreads the parsed body onto `error`.
    onError(ctx) {
      if (!promptLocalAuthIfRequired(ctx.error)) notifyPermissionDenied(ctx.error)
    },
  },
})
