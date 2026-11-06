import { renderInvitationEmail, renderNotificationEmail, renderPasswordSetEmail, renderResetPasswordEmail, renderVerificationEmail } from '../../server/utils/email-templates'

const url = 'https://example.invalid/x'
const NOTIFICATIONS = ['post.status_changed', 'post.admin_replied', 'post.created', 'post.user_commented']

// One rendering of every account and notification email, as flat strings.
export function emailSamples(brandName?: string): string[] {
  return [
    renderVerificationEmail({ url, name: 'Ann', brandName }),
    renderInvitationEmail({ url, orgName: 'Team & Co', brandName }),
    renderResetPasswordEmail({ url, name: 'Ann', brandName }),
    renderPasswordSetEmail({ name: 'Ann', brandName }),
    ...NOTIFICATIONS.flatMap((typeKey) => {
      const mail = renderNotificationEmail({ typeKey, postTitle: 'Dark mode', postUrl: url, preferencesUrl: `${url}/prefs`, to: 'open', note: 'Soon', snippet: 'Please', actorName: 'Bo', brandColor: '#112233', brandName })!
      return [mail.subject, mail.html, mail.text]
    }),
  ]
}
