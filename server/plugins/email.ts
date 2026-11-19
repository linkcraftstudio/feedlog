import { consola } from 'consola'

const logger = consola.withTag('email')

const FALLBACK_FROM_ADDRESS = 'onboarding@resend.dev'

export default defineNitroPlugin(() => {
  const resendApiKey = process.env.RESEND_API_KEY
  const emailFrom = process.env.EMAIL_FROM

  // Resend — register when API key is available
  if (resendApiKey) {
    const fromAddress = emailFrom || FALLBACK_FROM_ADDRESS
    registerEmailProvider({
      name: 'resend',
      send: async ({ to, subject, html, text, headers, idempotencyKey, fromName }) => {
        const from = formatSender(fromAddress, fromName)
        const response = await $fetch<{ id: string }>('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendApiKey}`, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
          body: { from, to, subject, html, text, headers },
          timeout: 10_000,
          retry: 0,
        })
        logger.info(`Email sent via Resend to=${to} id=${response.id}`)
      },
    })
    logger.info(`Registered email provider: resend (from=${fromAddress})`)
  }

  // Console — always registered as fallback for development
  registerEmailProvider({
    name: 'console',
    send: async (options) => {
      logger.info(`[DEV EMAIL] to=${options.to} subject=${options.subject}`)
      // Extract URLs from HTML so developers can click verification/reset links
      const urls = options.html.match(/href="([^"]+)"/g)?.map(m => m.slice(6, -1)) || []
      if (urls.length > 0) {
        logger.info(`[DEV EMAIL] action URL: ${urls[0]}`)
      }
    },
  })
  logger.info('Registered email provider: console')
})
