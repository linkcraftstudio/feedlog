import { createOpenAI } from '@ai-sdk/openai'
import type { MastraModelConfig } from '@mastra/core/llm'

// Some OpenAI-compatible providers, such as Workers AI, reject an assistant
// tool-call message whose content is null. The AI SDK has no option to change it.
export function emptyToolCallContent(body: string) {
  const request = JSON.parse(body)
  for (const message of request.messages ?? []) {
    if (message.role === 'assistant' && message.tool_calls && message.content === null) message.content = ''
  }
  return JSON.stringify(request)
}

export function agentModel(): MastraModelConfig {
  const apiKey = process.env.OPENAI_API_KEY
  const url = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  const model = process.env.OPENAI_TEXT_MODEL!
  if (process.env.OPENAI_TOOL_CALL_EMPTY_CONTENT !== 'true') return { id: `openai/${model}`, apiKey, url }
  return createOpenAI({
    apiKey,
    baseURL: url,
    fetch: (input, init) => fetch(input, typeof init?.body === 'string' ? { ...init, body: emptyToolCallContent(init.body) } : init),
  }).chat(model) as unknown as MastraModelConfig
}
