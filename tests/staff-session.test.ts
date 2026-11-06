import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasStaffAccess } from '../app/utils/staff-session'

test('only a session with an organization leaves the staff sign-in page', () => {
  assert.equal(hasStaffAccess(null), false)
  assert.equal(hasStaffAccess({ user: { isAnonymous: true } }), false)
  assert.equal(hasStaffAccess({ user: { id: 'sso' }, orgList: [] }), false)
  assert.equal(hasStaffAccess({ user: { id: 'staff' }, orgList: [{ role: 'owner' }] }), true)
})

test('the sign-in form opens in place on dashboard and invitation pages only', async () => {
  const { signsInInPlace } = await import('../app/utils/staff-session')
  for (const path of ['/dashboard/login', '/dashboard', '/invite', '/zh/invite', '/en/dashboard/posts', '/mcp/consent']) assert.equal(signsInInPlace(path), true, path)
  for (const path of ['/', '/roadmap', '/p/dashboard-ideas', '/invited', '/zh']) assert.equal(signsInInPlace(path), false, path)
})
