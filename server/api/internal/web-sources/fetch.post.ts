import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { CrawlError, fetchWebSourceUrl } from '#layers/feedlog/server/lib/web-source/fetch'

// Optional Node gateway for Workers, whose HTTP adapter cannot pin DNS lookups.
export default defineEventHandler(async event => {
  const token = process.env.WEB_SOURCE_FETCH_GATEWAY_TOKEN
  const supplied = getHeader(event, 'authorization')?.replace(/^Bearer /, '') ?? ''
  if (!token || import.meta.preset?.startsWith('cloudflare') || Buffer.byteLength(supplied) !== Buffer.byteLength(token)
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw createError({ statusCode: 404 })
  const input = z.object({ url: z.string().max(2048), headers: z.object({ 'If-None-Match': z.string().max(1000).optional(), 'If-Modified-Since': z.string().max(200).optional() }).default({}) }).strict().parse(await readBody(event))
  try {
    return await fetchWebSourceUrl(input.url, input.headers as Record<string, string>)
  } catch (error) {
    if (error instanceof CrawlError) throw createError({ statusCode: 422, data: { code: error.code, retryable: error.retryable }, message: error.code })
    throw error
  }
})
