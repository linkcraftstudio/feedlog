export const HELP_EMBEDDING_MODEL = 'text-embedding-3-large'
export const HELP_EMBEDDING_DIMENSIONS = 768
export const HELP_INDEX_VERSION = 'heading-v1'

export function helpVectorsEnabled() { return process.env.HELP_VECTOR_SEARCH === 'true' }
export class HelpEmbeddingError extends Error {
  constructor(public code: string, public retryable: boolean) { super(code) }
}

// Never persist provider response bodies, credentials, or article text in errors.
export async function embedHelpTexts(input: string[], timeoutMs = 20000): Promise<number[][]> {
  if (!process.env.OPENAI_API_KEY) throw new HelpEmbeddingError('not_configured', false)
  let response: Response
  try {
    response = await fetch(`${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/embeddings`, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: HELP_EMBEDDING_MODEL, dimensions: HELP_EMBEDDING_DIMENSIONS, input }),
    })
  } catch { throw new HelpEmbeddingError('provider_unavailable', true) }
  if (!response.ok) throw new HelpEmbeddingError(`provider_${response.status}`, [408, 409, 429].includes(response.status) || response.status >= 500)
  try {
    const payload = await response.json() as { data: { index: number; embedding: number[] }[] }
    const rows = payload.data.sort((a, b) => a.index - b.index)
    if (rows.length !== input.length || rows.some((r, i) => r.index !== i || r.embedding.length !== HELP_EMBEDDING_DIMENSIONS || r.embedding.some(n => !Number.isFinite(n)) || !r.embedding.some(n => n !== 0))) throw new Error('Invalid vectors')
    return rows.map(r => r.embedding)
  } catch { throw new HelpEmbeddingError('invalid_response', true) }
}
