// `auth` auto-imported from server/utils/better-auth.ts.

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: getHeaders(event) })
  if (!session) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }

  const body = await readBody<{ newPassword: string }>(event)
  if (!body?.newPassword) {
    throw createError({ statusCode: 400, message: 'newPassword is required' })
  }
  if (body.newPassword.length < 8) {
    throw createError({ statusCode: 400, message: 'Password must be at least 8 characters' })
  }
  if (body.newPassword.length > 128) {
    throw createError({ statusCode: 400, message: 'Password must be at most 128 characters' })
  }

  const accounts = await auth.api.listUserAccounts({ headers: getHeaders(event) })
  const hasCredential = accounts?.some(
    (acc: { providerId: string }) => acc.providerId === 'credential',
  )
  if (hasCredential) {
    throw createError({ statusCode: 400, message: 'Password already set. Use change-password instead.' })
  }

  const result = await auth.api.setPassword({
    body: { newPassword: body.newPassword },
    headers: getHeaders(event),
  })

  // Notify user that a password was added (security measure)
  await sendEmail({
    to: session.user.email,
    subject: 'Password added to your FeedLog account',
    html: renderPasswordSetEmail({ name: session.user.name }),
  })

  return result
})
