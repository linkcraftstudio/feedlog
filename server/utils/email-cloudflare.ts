import type { EmailProvider } from './email'

export interface SendEmailBinding {
  send(message: object): Promise<{ messageId: string }>
}

// Cloudflare Email Sending through the Worker's send_email binding. The binding
// takes no idempotency key and does not deduplicate, so idempotencyKey is not
// sent: delivery is at least once, and a send that Cloudflare accepted but that
// failed on the way back can arrive twice when the caller retries.
export function cloudflareEmailProvider(emailFrom: string | undefined, binding: () => SendEmailBinding | undefined): EmailProvider {
  if (!emailFrom) throw new Error('EMAIL_FROM required for the cloudflare email provider')
  return {
    name: 'cloudflare',
    send: async ({ to, subject, html, text, headers }) => {
      const email = binding()
      if (!email) throw new Error('EMAIL binding missing')
      const { messageId } = await email.send({ from: { email: emailFrom, name: 'FeedLog' }, to, subject, html, text, headers })
      console.info(`[email] Email sent via Cloudflare id=${messageId}`)
    },
  }
}
