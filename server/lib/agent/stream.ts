import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'

// Delay the protocol's finish event until the caller has committed business history.
export async function collectConversationReply(
  stream: ReadableStream<UIMessageChunk>,
  messageId: string,
  write: (chunk: UIMessageChunk) => void | Promise<void>,
) {
  let message: UIMessage | undefined
  let finish: Extract<UIMessageChunk, { type: 'finish' }> | undefined
  let failure: unknown
  const observed = stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
    async transform(chunk, controller) {
      const next = chunk.type === 'start' ? { ...chunk, messageId } : chunk
      if (next.type === 'finish') finish = next
      else if (next.type === 'abort' || next.type === 'error') failure = new Error('Response did not complete.')
      else await write(next)
      controller.enqueue(next)
    },
  }))
  for await (const snapshot of readUIMessageStream({ stream: observed, onError: error => { failure = error } })) {
    message = snapshot
  }
  if (failure) throw failure
  if (!message || !finish || (finish.finishReason && finish.finishReason !== 'stop')) {
    throw new Error('Response did not complete.')
  }
  return { message, finish }
}
