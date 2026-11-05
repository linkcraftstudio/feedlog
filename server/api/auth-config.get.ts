// Public read-only summary of which sign-in methods are enabled for this install.
// The LoginModal uses this to hide provider buttons that aren't configured.
// Sits at /api/auth-config (not /api/auth/config) to avoid shadowing the
// better-auth catch-all route at /api/auth/[...all].
//
import { resolveExternalAuthUrls } from '#layers/feedlog/shared/utils/external-auth'

// `authConfig` is auto-imported by Nitro from server/utils/better-auth.ts.
export default defineEventHandler(() => {
  const external = resolveExternalAuthUrls(
    process.env.EXTERNAL_LOGIN_URL,
    process.env.EXTERNAL_SIGNUP_URL,
  )

  return {
    ...authConfig,
    externalLoginUrl: external.login,
    externalSignupUrl: external.signup,
  }
})
