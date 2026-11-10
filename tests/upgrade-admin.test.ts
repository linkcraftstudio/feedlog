import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isUpgradeAdmin } from '../modules/cf-setup/runtime/server/utils/upgrade-admin'

const allow = ['owner@example.com']

test('a global admin and an allow-listed user may run upgrade migrations', () => {
  assert.equal(isUpgradeAdmin({ role: 'admin', email: 'a@example.com' }, allow), true)
  assert.equal(isUpgradeAdmin({ role: 'user', email: 'owner@example.com' }, allow), true)
})

test('an ordinary user and a missing session may not', () => {
  assert.equal(isUpgradeAdmin({ role: 'user', email: 'b@example.com' }, allow), false)
  assert.equal(isUpgradeAdmin({ role: 'user', email: null }, allow), false)
  assert.equal(isUpgradeAdmin(null, allow), false)
  assert.equal(isUpgradeAdmin({ role: 'user', email: '' }, ['']), false)
})

// The route's gate: a direct sign-in first, then the admin check.
const globals = globalThis as Record<string, unknown>
globals.createError = (e: { message?: string }) => Object.assign(new Error(e.message), e)
async function gate(result: unknown): Promise<boolean> {
  globals.auth = { api: { getSession: async () => result } }
  const { requireLocalSession } = await import('../server/utils/auth')
  const session = await requireLocalSession({ headers: new Headers(), context: { orgId: 'default-org' } } as never).catch(() => null)
  return isUpgradeAdmin(session?.user as never, allow)
}

test('a guest or a product SSO session may not, also with an allow-listed email or the admin role', async () => {
  assert.equal(await gate({ user: { role: 'user', email: 'owner@example.com', isAnonymous: true }, session: {} }), false)
  assert.equal(await gate({ user: { role: 'user', email: 'x@example.com' }, session: { ssoOrgId: 'default-org' } }), false)
  assert.equal(await gate({ user: { role: 'user', email: 'owner@example.com' }, session: { ssoOrgId: 'default-org' } }), false)
  assert.equal(await gate({ user: { role: 'admin', email: 'a@example.com' }, session: { ssoOrgId: 'default-org' } }), false)
  assert.equal(await gate(null), false)
})

test('a direct sign-in with an allow-listed email may', async () => {
  assert.equal(await gate({ user: { role: 'user', email: 'owner@example.com' }, session: {} }), true)
})
