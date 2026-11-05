// Public read-only summary of which sign-in methods are enabled for this install.
// The LoginModal uses this to hide provider buttons that aren't configured.
// Sits at /api/auth-config (not /api/auth/config) to avoid shadowing the
// better-auth catch-all route at /api/auth/[...all].
//
// `authConfig` is auto-imported by Nitro from server/utils/better-auth.ts.
export default defineEventHandler(() => authConfig)
