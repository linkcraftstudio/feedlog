import type { HandoffNotice } from '../inbox/state'
import type { Content, Run, StreamEvent } from './content'

type AgentEvent =
  | [name: 'run', data: { runId: string; itemId: string; run?: Run }]
  | [name: 'reset', data: { runId: string }]
  | [name: 'tool', data: Extract<StreamEvent, { type: 'tool' }>]
  | [name: 'text', data: { delta: string }]
  | [name: 'finish', data: { runId: string; itemId: string; lastSeq: number; content?: Content }]
  | [name: 'handoff' | 'closed', data: { runId: string; noticeItemId?: string; lastSeq: number; handling: 'human' | 'closed'; reason?: 'ai_error'; handoffNotice?: HandoffNotice; customerNotice?: string }]
  | [name: 'superseded', data: { runId: string }]
  | [name: 'handoff_unavailable', data: { runId: string }]
  | [name: 'error', data: { message: string; code?: string }]

export async function readAgentEvents(stream: ReadableStream<Uint8Array>, onEvent: (...event: AgentEvent) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const lines = block.split(/\r?\n/)
        const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        // Transport keepalives must never count as an answer or renew UI timeouts.
        if (name === 'heartbeat') continue
        if (name && data) onEvent(...[name, JSON.parse(data)] as AgentEvent)
      }
      if (done) return
    }
  } finally { reader.releaseLock() }
}
