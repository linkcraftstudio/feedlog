import OpenAI from 'openai'
import { and, eq, inArray } from 'drizzle-orm'
import { post } from '#layers/feedlog/server/db/schemas'
import { aiGenerateSchema } from '#layers/feedlog/shared/schemas/changelog'

const MAX_COMPLETION_TOKENS = 8192

// POST /api/admin/changelogs/ai/generate — AI changelog generation
// (feedlog:moderate — moderators only).
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })

  const body = await readValidatedBody(event, aiGenerateSchema.parse)

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw createError({ statusCode: 503, message: 'AI generation is not configured (OPENAI_API_KEY missing)' })
  }

  const baseURL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-5.4'

  // Fetch feedback posts if provided
  const feedback: { title: string; content: string }[] = []
  if (body.feedbackIds.length > 0) {
    const db = useDB()
    const posts = await db
      .select({ title: post.title, content: post.content })
      .from(post)
      .where(and(eq(post.orgId, orgId), inArray(post.id, body.feedbackIds)))

    feedback.push(...posts)
  }

  const style = body.style as AiStyle
  const systemPrompt = buildSystemPrompt(style)
  const userPrompt = buildUserPrompt(style, feedback, body.changeContent)

  const client = new OpenAI({ apiKey, baseURL })

  try {
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_completion_tokens: MAX_COMPLETION_TOKENS,
    })

    const raw = resp.choices[0]?.message?.content ?? ''
    const parsed = parseAiResponse(raw)

    // Map AI output to API response format
    const validTags = new Set(['new', 'improved', 'fixed'])
    const categories = parsed.suggested_tags.filter(t => validTags.has(t))

    return {
      title: parsed.title.slice(0, 70),
      categories,
      content: parsed.content_markdown,
    }
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      throw error // Re-throw H3 errors (e.g., from parseAiResponse)
    }
    const message = error instanceof Error ? error.message : 'Unknown AI error'
    throw createError({ statusCode: 502, message: `AI generation failed: ${message}` })
  }
})
