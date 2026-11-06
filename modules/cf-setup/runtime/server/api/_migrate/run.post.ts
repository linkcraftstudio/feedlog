import { runRuntimeMigration } from '#layers/feedlog/server/utils/runtime-migrate'
import { requireLocalSession } from '#layers/feedlog/server/utils/auth'
import { systemAdminEmails } from '#layers/feedlog/server/utils/better-auth'
import { probeDatabaseState, setCachedState } from '../../utils/migration-state'
import { resolveConnectionString } from '../../utils/connection-string'
import { isUpgradeAdmin } from '../../utils/upgrade-admin'

// Permission model:
//   - bootstrap state (tracker absent or empty): anonymous allowed — no admin
//     exists yet to authorize, so the first caller gets to run the initial
//     migrations. Subsequent calls hit the admin gate below.
//   - pending state (tracker rows < journal entries): requires a logged-in
//     admin: role admin, or an email in SYSTEM_ADMIN_EMAILS. Nothing sets the
//     role during sign-up. Upgrade migrations should not be triggerable by
//     anonymous traffic.
//   - migrated state: no-op, but still gated by admin to avoid info leaks.

function isCloudflare(): boolean {
  const p = import.meta.preset
  return p === 'cloudflare-module' || p === 'cloudflare-pages'
}

export default defineEventHandler(async (event) => {
  if (!isCloudflare()) throw createError({ statusCode: 404 })
  const connectionString = resolveConnectionString()
  if (!connectionString) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Database connection not configured',
      data: { code: 'NO_BINDING' },
    })
  }

  const preSnapshot = await probeDatabaseState(connectionString)
  const isBootstrap = preSnapshot.state === 'bootstrap'

  let triggerSource = 'bootstrap'
  if (!isBootstrap) {
    // A guest or a product SSO session is not a direct sign-in: its email was
    // asserted by one organization, and migrations change the whole install.
    const session = await requireLocalSession(event).catch(() => null)
    if (!isUpgradeAdmin(session?.user, systemAdminEmails)) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: { code: 'REQUIRES_ADMIN', state: preSnapshot.state },
      })
    }
    triggerSource = `admin:${session?.user?.id ?? 'unknown'}`
  }

  console.log(`[cf-setup] migrate triggered: source=${triggerSource}, pre-state=${preSnapshot.state}`)
  const result = await runRuntimeMigration(connectionString)
  if (!result.ok) {
    console.error(`[cf-setup] migrate failed: ${result.error}`)
    setCachedState(null)
    throw createError({
      statusCode: 500,
      statusMessage: 'Migration Failed',
      data: { error: result.error, durationMs: result.durationMs },
    })
  }

  const postSnapshot = await probeDatabaseState(connectionString)
  setCachedState(postSnapshot)
  console.log(
    `[cf-setup] migrate ok: source=${triggerSource}, ${result.applied?.length ?? 0} rows in tracker, ${result.durationMs}ms`,
  )

  return {
    ok: true,
    triggerSource,
    durationMs: result.durationMs,
    state: postSnapshot,
  }
})
