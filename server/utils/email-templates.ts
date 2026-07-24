// Email HTML templates — auto-imported by Nitro.
// Brand primary color matches public/logo.svg.
import { STATUS_CONFIG } from '../../shared/types/post'

const BRAND_COLOR = '#C45A46'
const FONT_STACK = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`

function layout({ preheader, content }: { preheader: string; content: string }): string {
  return `
<div style="font-family: ${FONT_STACK}; max-width: 600px; margin: 0 auto; padding: 32px 24px; color: #111827; line-height: 1.55;">
  <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">${preheader}</div>
  <div style="padding-bottom: 20px; border-bottom: 1px solid #e5e7eb; margin-bottom: 24px;">
    <span style="font-size: 20px; font-weight: 700; color: ${BRAND_COLOR}; letter-spacing: -0.01em;">FeedLog</span>
  </div>
  ${content}
  ${signature()}
</div>
`
}

function actionButton(url: string, label: string): string {
  return `<a href="${url}" style="display: inline-block; padding: 12px 24px; background: ${BRAND_COLOR}; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">${label}</a>`
}

function fallbackLink(url: string): string {
  const shown = url.length <= 80 ? url : `${url.slice(0, 80)}...`
  return `
<p style="color: #6b7280; margin: 24px 0 4px; font-size: 13px;">Button not working? Paste this link into your browser:</p>
<p style="margin: 0 0 24px; font-size: 12px; word-break: break-all;">
  <a href="${url}" style="color: ${BRAND_COLOR}; text-decoration: underline;">${shown}</a>
</p>
`
}

function expiryNote(text: string): string {
  return `<p style="color: #6b7280; margin: 0 0 24px; font-size: 13px;">${text}</p>`
}

function signature(): string {
  return `
<div style="border-top: 1px solid #e5e7eb; padding-top: 20px; color: #6b7280; font-size: 13px;">
  &mdash; The FeedLog Team<br>
  <a href="https://feedlog.ai" style="color: #6b7280; text-decoration: underline;">feedlog.ai</a>
  &middot;
  <a href="mailto:feedlog.oss@outlook.com" style="color: #6b7280; text-decoration: underline;">feedlog.oss@outlook.com</a>
</div>
`
}

// --- Templates ---

export function renderVerificationEmail({ url, name }: { url: string; name: string }): string {
  return layout({
    preheader: 'One click to activate · link expires in 1 hour.',
    content: `
<h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 600;">Confirm your email to get started</h2>
<p style="margin: 0 0 12px;">Hi ${escapeHtml(name)},</p>
<p style="margin: 0 0 12px;">Confirm your email to activate your FeedLog account and start:</p>
<ul style="margin: 0 0 24px; padding-left: 20px; color: #374151;">
  <li style="margin-bottom: 4px;">Voting on features you care about</li>
  <li style="margin-bottom: 4px;">Submitting feedback and ideas</li>
  <li>Following updates on what ships next</li>
</ul>
${actionButton(url, 'Confirm Email')}
${fallbackLink(url)}
${expiryNote('This link expires in 1 hour. If you didn\'t sign up for FeedLog, you can safely ignore this email.')}
`,
  })
}

export function renderInvitationEmail({ url, orgName }: { url: string; orgName: string }): string {
  return layout({
    preheader: `You're invited to join ${escapeHtml(orgName)} on FeedLog.`,
    content: `
<h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 600;">Join ${escapeHtml(orgName)} on FeedLog</h2>
<p style="margin: 0 0 12px;">You've been invited to collaborate. Click below to accept and get started:</p>
${actionButton(url, 'Accept invitation')}
${fallbackLink(url)}
${expiryNote('This invitation link is tied to your email. If you weren\'t expecting it, you can safely ignore this message.')}
`,
  })
}

export function renderResetPasswordEmail({ url, name }: { url: string; name: string }): string {
  return layout({
    preheader: 'A password reset was requested for your account. If it wasn\'t you, ignore this email.',
    content: `
<h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 600;">Reset your password</h2>
<p style="margin: 0 0 12px;">Hi ${escapeHtml(name)},</p>
<p style="margin: 0 0 24px;">Someone requested a password reset for your FeedLog account. If this was you, click the button below to set a new password:</p>
${actionButton(url, 'Reset Password')}
${fallbackLink(url)}
${expiryNote('This link expires in 1 hour and can only be used once.')}
<div style="border-top: 1px solid #e5e7eb; padding-top: 20px; margin-bottom: 24px;">
  <p style="margin: 0 0 12px; font-weight: 600; color: #111827;">Didn't request this?</p>
  <p style="margin: 0 0 12px; color: #374151;">You can safely ignore this email &mdash; your password won't change unless you click the link above.</p>
</div>
`,
  })
}

export function renderPasswordSetEmail({ name }: { name: string }): string {
  const contact = `<a href="mailto:feedlog.oss@outlook.com" style="color: ${BRAND_COLOR}; text-decoration: underline;">feedlog.oss@outlook.com</a>`
  return layout({
    preheader: 'If this wasn\'t you, reset your password immediately.',
    content: `
<h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 600;">A password was added to your account</h2>
<p style="margin: 0 0 16px;">Hi ${escapeHtml(name)},</p>
<p style="margin: 0 0 16px;">A password was just added to your FeedLog account. You can now sign in with email and password in addition to your social login.</p>
<p style="margin: 0 0 24px; color: #374151;">If this wasn't you, reset your password right away and contact ${contact}.</p>
`,
  })
}

// --- Notification templates (English only, Featurebase-style) ---

// User-authored text (titles, notes, comment snippets) enters the HTML body
// here, so every interpolation is escaped.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export interface NotificationEmailContent {
  subject: string
  html: string
  text: string
}

const FOOTER_REASON = 'You\'re receiving this because of your activity on this FeedLog board.'

// Gray page → centered FeedLog wordmark → white rounded card → centered footer.
// No links in the footer; the physical postal address (CAN-SPAM) is a pre-launch
// item, not fabricated here.
function notificationShell(cardInner: string, preheader: string): string {
  return `
<div style="background: #f6f7fb; padding: 40px 16px; font-family: ${FONT_STACK};">
  <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">${escapeHtml(preheader)}</div>
  <div style="max-width: 560px; margin: 0 auto;">
    <div style="text-align: center; padding-bottom: 28px;">
      <span style="font-size: 22px; font-weight: 800; color: ${BRAND_COLOR}; letter-spacing: -0.02em;">FeedLog</span>
    </div>
    <div style="background: #fff; border: 1px solid #eceef3; border-radius: 16px; padding: 40px 36px;">
${cardInner}
    </div>
    <div style="text-align: center; padding: 24px 8px 0; color: #9ca3af; font-size: 12px; line-height: 1.6;">
      <p style="margin: 0;">${FOOTER_REASON}</p>
    </div>
  </div>
</div>`
}

function pillButton(url: string, label: string): string {
  return `<div style="text-align: center; margin-top: 32px;"><a href="${url}" style="display: inline-block; padding: 14px 40px; background: ${BRAND_COLOR}; color: #fff; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 16px;">${label}</a></div>`
}

function statusChangeCard(title: string, to: string, note?: string): NotificationEmailContent {
  const cfg = STATUS_CONFIG[to as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open
  const label = cfg.label
  const noteHtml = note
    ? `<p style="margin: 20px 0 0; text-align: center; font-size: 15px; color: #6b7280; line-height: 1.7;">${escapeHtml(note)}</p>`
    : ''
  const inner = `
      <p style="margin: 0; text-align: center; font-size: 20px; line-height: 1.5; color: #1f2937;">
        A post you upvoted, <strong style="color: #111827;">${escapeHtml(title)}</strong>, has been changed to <span style="color: ${cfg.color}; font-weight: 700;">${label}</span>
      </p>${noteHtml}
      ${pillButton('{{postUrl}}', 'View post')}`
  return {
    subject: `${label} - "${title}"`,
    html: inner,
    text: `A post you upvoted, ${title}, has been changed to ${label}.${note ? `\n\n${note}` : ''}`,
  }
}

function adminReplyCard(title: string, actorName: string, actorImage: string | null | undefined, snippet: string): NotificationEmailContent {
  const initial = (actorName || '?').charAt(0).toUpperCase()
  // Only trust an http(s) URL as a src; anything else falls back to the initial avatar.
  const safeImage = actorImage && /^https?:\/\//i.test(actorImage) ? actorImage : null
  const avatar = safeImage
    ? `<img src="${escapeHtml(safeImage)}" width="40" height="40" style="border-radius: 999px; display: block;" alt="">`
    : `<div style="width: 40px; height: 40px; border-radius: 999px; background: ${BRAND_COLOR}; color: #fff; font-size: 16px; font-weight: 700; text-align: center; line-height: 40px;">${escapeHtml(initial)}</div>`
  const inner = `
      <p style="margin: 0 0 20px; font-size: 17px; font-weight: 700; color: #111827; line-height: 1.4;">${escapeHtml(title)}</p>
      <table cellpadding="0" cellspacing="0" style="width: 100%;"><tr>
        <td width="48" valign="top">${avatar}</td>
        <td valign="top" style="padding-left: 4px;">
          <div style="font-size: 16px; font-weight: 700; color: #111827; margin-bottom: 4px;">${escapeHtml(actorName)}</div>
          <div style="font-size: 15px; color: #6b7280; line-height: 1.7;">${escapeHtml(snippet)}</div>
        </td>
      </tr></table>
      ${pillButton('{{postUrl}}', 'View comment')}`
  return {
    subject: `New comment for "${title}"`,
    html: inner,
    text: `${actorName} commented on "${title}":\n\n${snippet}`,
  }
}

// Dispatch a notification to its template. Returns null for an unknown type so
// the caller logs it rather than sending a blank email.
export function renderNotificationEmail(input: {
  typeKey: string
  postTitle?: string
  postUrl: string
  to?: string
  note?: string
  snippet?: string
  actorName?: string
  actorImage?: string | null
}): NotificationEmailContent | null {
  const title = input.postTitle || 'your post'
  let card: NotificationEmailContent | null = null
  let preheader = ''

  switch (input.typeKey) {
    case 'post.status_changed': {
      const label = (STATUS_CONFIG[(input.to ?? 'open') as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).label
      card = statusChangeCard(title, input.to ?? 'open', input.note)
      preheader = `"${title}" is now ${label}.`
      break
    }
    case 'post.admin_replied':
      card = adminReplyCard(title, input.actorName ?? 'The team', input.actorImage, input.snippet ?? '')
      preheader = `An official reply on "${title}".`
      break
    default:
      return null
  }

  const html = notificationShell(card.html.replaceAll('{{postUrl}}', input.postUrl), preheader)
  const text = `${card.text}\n\nView: ${input.postUrl}\n\n—\n${FOOTER_REASON}`
  return { subject: card.subject, html, text }
}
