import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { createApp, createError, createRouter, defineEventHandler, readBody, setResponseHeader, toNodeListener } from 'h3'
import { resolveMemberNotifications, updateMemberPreferenceSchema } from '../shared/schemas/member-preference'
import { findOwnMemberPreference, findStaffFeedbackRecipients, saveMemberNotifications } from '../server/services/member-preferences'
import { renderNotificationEmail } from '../server/utils/email-templates'
import { requireOrgMember } from '../server/utils/auth'
import { registerEmailProvider, type SendEmailOptions } from '../server/utils/email'
import { sendNotification } from '../server/utils/notification-send'
import { registerPostLinkBuilder } from '../server/utils/post-link-builder'

test('only absent preferences inherit the default; false survives and malformed data fails', () => {
  for (const stored of [undefined, {}, { future_setting: false }]) {
    assert.equal(resolveMemberNotifications(stored).staff_feedback_email_enabled, true)
  }
  assert.equal(resolveMemberNotifications({ staff_feedback_email_enabled: false }).staff_feedback_email_enabled, false)
  for (const stored of [null, [], false, 'false', { staff_feedback_email_enabled: null }, { staff_feedback_email_enabled: 'false' }]) {
    assert.throws(() => resolveMemberNotifications(stored))
  }
})

test('patch only accepts the documented boolean and rejects identity overrides', () => {
  const body = { notifications: { staff_feedback_email_enabled: false } }
  assert.deepEqual(updateMemberPreferenceSchema.parse(body), body)
  for (const invalid of [
    null, {}, { notifications: null }, { notifications: {} },
    { notifications: { staff_feedback_email_enabled: 0 } },
    { notifications: { staff_feedback_email_enabled: null } },
    { notifications: { staff_feedback_email_enabled: 'false' } },
    { notifications: { ...body.notifications, unknown: true } },
    ...['userId', 'memberId', 'orgId'].map(key => ({ ...body, [key]: 'someone-else' })),
  ]) assert.equal(updateMemberPreferenceSchema.safeParse(invalid).success, false)
})

async function fixture() {
  const client = new PGlite()
  await client.exec(`
    CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL);
    CREATE TABLE organization (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE member (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      role text NOT NULL
    );
    INSERT INTO "user" VALUES
      ('a', 'Alex', 'a@example.com'), ('b', 'Blair', 'b@example.com'),
      ('c', 'Casey', 'c@example.com'), ('actor', 'Actor', 'actor@example.com');
    INSERT INTO organization VALUES ('one', 'First workspace'), ('two', 'Second workspace');
    INSERT INTO member VALUES
      ('one-a', 'a', 'one', 'owner'), ('one-b', 'b', 'one', 'manager'),
      ('one-c', 'c', 'one', 'contributor'), ('one-actor', 'actor', 'one', 'owner'),
      ('two-a', 'a', 'two', 'owner');
  `)
  await client.exec(await readFile(new URL('../server/db/migrations/0016_member_preferences.sql', import.meta.url), 'utf8'))
  return { client, db: drizzle(client) }
}

test('database preferences isolate members, merge keys, follow roles, and cascade on removal', async () => {
  const { client, db } = await fixture()
  try {
    const recipientIds = async (org = 'one') => (await findStaffFeedbackRecipients(db, org, 'actor')).map(row => row.userId).sort()
    assert.deepEqual(await recipientIds(), ['a', 'b'])
    const original = await findOwnMemberPreference(db, 'one', 'a')
    assert.equal(original?.preference, null)
    assert.equal(original?.organization.name, 'First workspace')
    assert.equal(await findOwnMemberPreference(db, 'two', 'b'), undefined)
    assert.equal((await client.query('SELECT * FROM member_preference')).rows.length, 0)

    await saveMemberNotifications(db, 'one-a', { staff_feedback_email_enabled: false })
    assert.deepEqual(await recipientIds(), ['b'])
    assert.deepEqual(await recipientIds('two'), ['a'])
    assert.equal((await findOwnMemberPreference(db, 'one', 'a'))?.preference?.notifications.staff_feedback_email_enabled, false)

    await client.exec(`UPDATE member_preference SET notifications = notifications || '{"future_setting": false}'::jsonb WHERE member_id = 'one-a'`)
    await Promise.all([
      saveMemberNotifications(db, 'one-a', { staff_feedback_email_enabled: true }),
      client.exec(`UPDATE member_preference SET notifications = notifications || '{"another_setting": "kept"}'::jsonb WHERE member_id = 'one-a'`),
    ])
    const stored = (await client.query<{ notifications: unknown }>("SELECT notifications FROM member_preference WHERE member_id = 'one-a'")).rows[0]!.notifications
    assert.deepEqual(stored, { staff_feedback_email_enabled: true, future_setting: false, another_setting: 'kept' })

    await Promise.all([
      client.exec(`INSERT INTO member_preference (member_id, notifications) VALUES ('one-c', '{"future_setting": true}') ON CONFLICT (member_id) DO UPDATE SET notifications = member_preference.notifications || EXCLUDED.notifications`),
      saveMemberNotifications(db, 'one-c', { staff_feedback_email_enabled: false }),
    ])
    assert.deepEqual((await client.query<{ notifications: unknown }>("SELECT notifications FROM member_preference WHERE member_id = 'one-c'")).rows[0]!.notifications,
      { future_setting: true, staff_feedback_email_enabled: false })
    await client.exec("UPDATE member SET role = 'manager' WHERE id = 'one-c'")
    assert.deepEqual(await recipientIds(), ['a', 'b'])
    await saveMemberNotifications(db, 'one-c', { staff_feedback_email_enabled: true })
    assert.deepEqual(await recipientIds(), ['a', 'b', 'c'])
    await client.exec("UPDATE member SET role = 'contributor' WHERE id = 'one-c'")
    assert.deepEqual(await recipientIds(), ['a', 'b'])

    await client.exec(`UPDATE member_preference SET notifications = '{"staff_feedback_email_enabled": "false"}' WHERE member_id = 'one-a'`)
    await assert.rejects(findStaffFeedbackRecipients(db, 'one', 'actor'))
    await saveMemberNotifications(db, 'one-a', { staff_feedback_email_enabled: false })
    await client.exec("DELETE FROM member WHERE id = 'one-a'")
    assert.equal((await client.query("SELECT * FROM member_preference WHERE member_id = 'one-a'")).rows.length, 0)
    await client.exec("INSERT INTO member VALUES ('one-a-new', 'a', 'one', 'owner')")
    assert.deepEqual(await recipientIds(), ['a', 'b'])
    await client.exec('DROP TABLE member_preference')
    await assert.rejects(findStaffFeedbackRecipients(db, 'one', 'actor'))
  }
  finally { await client.close() }
})

test('real preference handlers enforce session, current membership, SSO host binding, and strict writes', async () => {
  const { client, db } = await fixture()
  const orgList = [{ orgId: 'one', role: 'owner' }, { orgId: 'two', role: 'owner' }]
  Object.assign(globalThis, {
    defineEventHandler, createError, readBody, setResponseHeader, requireOrgMember,
    useDB: () => db,
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      const identity = headers.get('x-test-session')
      if (!identity) return null
      return {
        user: { id: identity === 'contributor' ? 'c' : 'a', isAnonymous: identity === 'guest' },
        session: { ssoOrgId: identity === 'sso' ? 'one' : null },
        orgList: identity === 'nonmember' ? [] : orgList,
      }
    } } },
  })
  const get = (await import('../server/api/me/preferences.get')).default
  const patch = (await import('../server/api/me/preferences.patch')).default
  const app = createApp()
  app.use(defineEventHandler(event => { event.context.orgId = event.headers.get('x-test-org') || 'one' }))
  app.use(createRouter().get('/api/me/preferences', get).patch('/api/me/preferences', patch))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const request = (identity: string, method = 'GET', body?: unknown, org = 'one') => fetch(`http://127.0.0.1:${address.port}/api/me/preferences`, {
    method, headers: { 'x-test-session': identity, 'x-test-org': org, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  try {
    for (const [identity, code] of [['', 401], ['guest', 403], ['nonmember', 403]] as const) {
      assert.equal((await request(identity)).status, code)
      assert.equal((await request(identity, 'PATCH', { notifications: { staff_feedback_email_enabled: false } })).status, code)
    }
    const res = await request('local')
    assert.equal(res.headers.get('cache-control'), 'private, no-store')
    assert.equal((await res.json()).notifications.staff_feedback_email_enabled, true)
    assert.equal((await request('local', 'PATCH', { notifications: { staff_feedback_email_enabled: false }, memberId: 'one-b' })).status, 400)
    const sso = await request('sso', 'PATCH', { notifications: { staff_feedback_email_enabled: false } })
    assert.equal(sso.status, 200)
    assert.equal((await sso.json()).notifications.staff_feedback_email_enabled, false)
    assert.equal((await request('sso', 'PATCH', { notifications: { staff_feedback_email_enabled: true } }, 'two')).status, 401)
    assert.equal((await (await request('local', 'GET', undefined, 'two')).json()).notifications.staff_feedback_email_enabled, true)
    assert.equal((await request('contributor', 'PATCH', { notifications: { staff_feedback_email_enabled: false } })).status, 200)
    await client.exec("DELETE FROM member WHERE id = 'one-a'")
    assert.equal((await request('local')).status, 403)
    assert.equal((await request('local', 'PATCH', { notifications: { staff_feedback_email_enabled: true } })).status, 403)
  }
  finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    await client.close()
  }
})

test('only staff feedback emails link to personal settings, in HTML and plain text', () => {
  const preferencesUrl = 'https://team.example.com/dashboard/settings/personal?x=1&y=2'
  for (const typeKey of ['post.created', 'post.user_commented', 'post.admin_replied', 'post.status_changed']) {
    const mail = renderNotificationEmail({ typeKey, postTitle: 'A <request>', postUrl: 'https://team.example.com/p/test', preferencesUrl })!
    const staff = typeKey === 'post.created' || typeKey === 'post.user_commented'
    assert.equal(mail.html.includes('Manage email notifications'), staff)
    assert.equal(mail.text.includes(preferencesUrl), staff)
    if (staff) assert.ok(mail.html.includes('personal?x=1&amp;y=2'))
    assert.ok(!mail.html.includes('A <request>'))
  }
})

test('delivery uses the organization link builder for settings without sending external email', async () => {
  const delivered: SendEmailOptions[] = []
  const previousProvider = process.env.EMAIL_PROVIDER
  registerEmailProvider({ name: 'preference-test', send: async options => { delivered.push(options) } })
  process.env.EMAIL_PROVIDER = 'preference-test'
  registerPostLinkBuilder((slug, path) => `https://${slug}.example.com${path}`)
  try {
    for (const typeKey of ['post.created', 'post.user_commented', 'post.admin_replied', 'post.status_changed'] as const) {
      await sendNotification({
        orgId: 'one', orgSlug: 'first', brandColor: '#C45A46', recipientEmail: 'a@example.com',
        typeKey, postSlug: 'test', postTitle: 'Test', payload: {}, requestOrigin: 'https://another.example.com',
      })
    }
    assert.equal(delivered.length, 4)
    for (const email of delivered.slice(0, 2)) {
      assert.ok(email.html.includes('https://first.example.com/dashboard/settings/personal'))
      assert.ok(email.text?.includes('https://first.example.com/dashboard/settings/personal'))
      assert.ok(!email.html.includes('another.example.com'))
    }
    for (const email of delivered.slice(2)) assert.ok(!email.html.includes('/dashboard/settings/personal'))
  }
  finally {
    if (previousProvider === undefined) delete process.env.EMAIL_PROVIDER
    else process.env.EMAIL_PROVIDER = previousProvider
    registerPostLinkBuilder((_slug, path, origin) => `${process.env.BETTER_AUTH_URL || origin}${path}`)
  }
})
