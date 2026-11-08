// Email sending abstraction — Registry pattern
// Auto-imported by Nitro, available in all server/ code

export interface SendEmailOptions {
  to: string
  idempotencyKey?: string
  subject: string
  html: string
  text?: string
  headers?: Record<string, string> // custom headers, e.g. List-Unsubscribe (RFC 8058)
}

export interface EmailProvider {
  name: string
  send(options: SendEmailOptions): Promise<void>
}

// --- Registry ---
const providers = new Map<string, EmailProvider>()

export function registerEmailProvider(provider: EmailProvider) {
  providers.set(provider.name, provider)
}

export function resolveEmailProvider(): EmailProvider {
  const preferred = process.env.EMAIL_PROVIDER

  // 1. Explicitly specified provider
  if (preferred && providers.has(preferred))
    return providers.get(preferred)!

  // 2. Fallback by priority
  for (const name of ['resend', 'console']) {
    if (providers.has(name)) return providers.get(name)!
  }

  throw new Error('No email provider registered')
}

// `.invalid` is reserved by RFC 2606 and can never resolve. Guest rows and
// seeded sample customers carry such addresses, so every send path treats them
// as having no email instead of handing them to a provider.
export function isUndeliverableEmail(email: string | null | undefined): boolean {
  return !!email && /\.invalid$/i.test(email.trim())
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  if (isUndeliverableEmail(options.to)) return
  // Defense-in-depth: a subject is a single header line, so collapse any CR/LF —
  // a subject carrying user data (post title, org name) can't inject extra headers.
  const subject = options.subject.replace(/[\r\n]+/g, ' ')
  await resolveEmailProvider().send({ ...options, subject })
}
