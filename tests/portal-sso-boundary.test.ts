import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getOrgMemberRole, requireOrgMember, requireOrgOwner, requireOrgPermission } from '../server/utils/auth.ts'
import { guardSsoAuthRequest } from '../server/utils/sso-auth-guard.ts'

function portalSession(orgId = 'one') {
  return {
    session: { id: 'session', ssoOrgId: orgId },
    // Same global user/email as an existing organization owner. This models
    // findOrCreateSsoUser resolving the JWT identity onto the owner's row.
    user: { id: 'existing-owner', email: 'owner@example.com', isAnonymous: false },
    orgList: [{ orgId, role: 'owner' }],
  }
}

function event(path: string, orgId = 'one') {
  return { path, headers: new Headers(), context: { orgId, orgSlug: orgId } } as never
}

test('an existing owner matched by email receives no staff role through portal SSO', () => {
  assert.equal(getOrgMemberRole(portalSession() as never, 'one'), null)
  assert.equal(getOrgMemberRole({
    session: { id: 'local', ssoOrgId: null },
    user: { id: 'user', isAnonymous: false },
    orgList: [{ orgId: 'one', role: 'manager' }],
  } as never, 'one'), 'manager')
})

test('an existing owner matched by email cannot pass any staff API authorization helper', async () => {
  let permissionChecked = false
  Object.assign(globalThis, {
    auth: { api: {
      getSession: async () => portalSession(),
      hasPermission: async () => {
        permissionChecked = true
        return { success: true, error: null }
      },
    } },
    createError: (input: Record<string, unknown>) => Object.assign(new Error(String(input.message)), input),
  })

  for (const authorize of [
    () => requireOrgMember(event('/api/admin/posts')),
    () => requireOrgPermission(event('/api/admin/posts'), { feedlog: ['moderate'] }),
    () => requireOrgOwner(event('/api/developer/sso/secrets')),
  ]) {
    await assert.rejects(
      authorize,
      (error: Error & { statusCode?: number, data?: { code?: string } }) => {
        assert.equal(error.statusCode, 403)
        assert.equal(error.data?.code, 'LOCAL_AUTH_REQUIRED')
        return true
      },
    )
  }
  assert.equal(permissionChecked, false, 'SSO must be rejected before Better Auth evaluates owner permissions')
})

test('an existing owner matched by email cannot call Better Auth organization or admin routes', async () => {
  Object.assign(globalThis, {
    auth: { api: { getSession: async () => portalSession() } },
    createError: (input: Record<string, unknown>) => Object.assign(new Error(String(input.message)), input),
  })

  for (const path of [
    '/api/auth/organization/list-members',
    '/api/auth/organization/accept-invitation',
    '/api/auth/admin/list-users',
  ]) {
    await assert.rejects(
      () => guardSsoAuthRequest(event(path), new Request(`https://one.example.com${path}`)),
      (error: Error & { statusCode?: number, data?: { code?: string } }) => {
        assert.equal(error.statusCode, 403)
        assert.equal(error.data?.code, 'LOCAL_AUTH_REQUIRED')
        return true
      },
    )
  }
})

test('portal session discovery remains host-bound while local sessions are unchanged', async () => {
  Object.assign(globalThis, {
    auth: { api: { getSession: async () => portalSession() } },
    createError: (input: Record<string, unknown>) => Object.assign(new Error(String(input.message)), input),
  })
  assert.equal(await guardSsoAuthRequest(event('/api/auth/get-session'), new Request('https://one.example.com/api/auth/get-session')), false)
  assert.equal(await guardSsoAuthRequest(event('/api/auth/get-session', 'two'), new Request('https://two.example.com/api/auth/get-session')), true)
  // A portal session may switch to a real dashboard identity through any
  // existing local method; these routes must remain untouched by the guard.
  for (const path of ['/api/auth/sign-in/email', '/api/auth/sign-in/social', '/api/auth/sign-up/email']) {
    assert.equal(await guardSsoAuthRequest(event(path), new Request(`https://one.example.com${path}`)), false)
  }

  ;(globalThis as { auth?: unknown }).auth = { api: { getSession: async () => ({
    session: { id: 'local', ssoOrgId: null },
    user: { id: 'user', isAnonymous: false },
  }) } }
  assert.equal(await guardSsoAuthRequest(event('/api/auth/organization/list-members'), new Request('https://one.example.com/api/auth/organization/list-members')), false)
  assert.equal(await guardSsoAuthRequest(event('/api/auth/organization/accept-invitation'), new Request('https://one.example.com/api/auth/organization/accept-invitation')), false)
})

test('dashboard entry requests local login and admits an existing local member', async () => {
  let currentSession: unknown = null
  Object.assign(globalThis, {
    defineNuxtRouteMiddleware: (handler: () => unknown) => handler,
    useAuthSession: async () => ({ data: { value: currentSession } }),
    navigateTo: (target: unknown) => target,
  })
  const middleware = (await import('../app/middleware/admin.ts')).default as unknown as () => Promise<unknown>
  const localLogin = { path: '/', query: { dashboard_login: '1' } }

  assert.deepEqual(await middleware(), localLogin)
  currentSession = portalSession()
  assert.deepEqual(await middleware(), localLogin)
  currentSession = {
    session: { id: 'local', ssoOrgId: null },
    user: { id: 'staff' },
    orgList: [{ orgId: 'one', role: 'manager' }],
  }
  assert.equal(await middleware(), undefined)
})
