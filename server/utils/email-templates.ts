// Email HTML templates — auto-imported by Nitro.
// Brand primary color matches public/logo.svg.

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
<p style="margin: 0 0 12px;">Hi ${name},</p>
<p style="margin: 0 0 12px;">Confirm your email to activate your FeedLog account and start:</p>
<ul style="margin: 0 0 24px; padding-left: 20px; color: #374151;">
  <li style="margin-bottom: 4px;">Voting on features you care about</li>
  <li style="margin-bottom: 4px;">Submitting feedback and ideas</li>
  <li>Following updates on what ships next</li>
</ul>
${actionButton(url, 'Confirm Email')}
${fallbackLink(url)}
${expiryNote("This link expires in 1 hour. If you didn't sign up for FeedLog, you can safely ignore this email.")}
`,
  })
}

export function renderInvitationEmail({ url, orgName }: { url: string; orgName: string }): string {
  return layout({
    preheader: `You're invited to join ${orgName} on FeedLog.`,
    content: `
<h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 600;">Join ${orgName} on FeedLog</h2>
<p style="margin: 0 0 12px;">You've been invited to collaborate. Click below to accept and get started:</p>
${actionButton(url, 'Accept invitation')}
${fallbackLink(url)}
${expiryNote('This invitation link is tied to your email. If you weren\'t expecting it, you can safely ignore this message.')}
`,
  })
}

export function renderResetPasswordEmail({ url, name }: { url: string; name: string }): string {
  return layout({
    preheader: "A password reset was requested for your account. If it wasn't you, ignore this email.",
    content: `
<h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 600;">Reset your password</h2>
<p style="margin: 0 0 12px;">Hi ${name},</p>
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
  return layout({
    preheader: "If this wasn't you, reset your password immediately.",
    content: `
<h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 600;">A password was added to your account</h2>
<p style="margin: 0 0 16px;">Hi ${name},</p>
<p style="margin: 0 0 16px;">A password was just added to your FeedLog account. You can now sign in with email and password in addition to your social login.</p>
<p style="margin: 0 0 24px; color: #374151;">If this wasn't you, reset your password right away and contact <a href="mailto:feedlog.oss@outlook.com" style="color: ${BRAND_COLOR}; text-decoration: underline;">feedlog.oss@outlook.com</a>.</p>
`,
  })
}
