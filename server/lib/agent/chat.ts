import { watchRun } from './run-monitor'
import { agentTiming } from './timing'
import { resolveAgentMaxSteps } from './config'
import { AgentDependencyTimeout } from './dependency-timeout'
import { HandoffProtocolError, handoffTextGate } from './handoff-protocol'
import { createRunActivity } from './run-activity'
import { startStreamHeartbeat } from './stream-heartbeat'
import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { toAISdkStream } from '@mastra/ai-sdk'
import { createEventStream, type H3Event } from 'h3'
import { chatInput, contentSchema, type Part } from '#layers/feedlog/shared/agent/content'
import { type Actor, agentRuntime, agentError } from '#layers/feedlog/server/lib/agent/runtime'
import { handoff } from '../inbox/service'
import { requestSchedule } from '../inbox/platform'
import { handling, handoffNotice } from '../../../shared/inbox/state'
import { publicItem, publicRun } from './runtime'
import { imageExecutionError } from './errors'
import { ChatImageError } from '../../../shared/agent/images'
import { startRun, failRun, completeRun, renewRun, readStoppedRun } from '#layers/feedlog/server/lib/agent/conversations'
import { prepareAgent, customerMemoryMessage } from '#layers/feedlog/server/lib/agent/agent'
import { collectConversationReply } from '#layers/feedlog/server/lib/agent/stream'
import { keepVerifiedHelpReferences, removeUnverifiedAnswerLinks, verifyHelpCitations } from '#layers/feedlog/server/lib/agent/citation-evidence'
import { addTokenUsage, type RunTokenUsage } from '#layers/feedlog/shared/agent/usage'

export async function streamAgentReply(event: H3Event, actor: Actor, options: { aiUnavailable?: boolean } = {}) {
  const started = performance.now()
  const aiConfigured = !options.aiUnavailable && !!process.env.OPENAI_API_KEY && !!process.env.OPENAI_TEXT_MODEL
  const firstAnswerDeadline = Date.now() + 120_000
  await assertGuestMay(event, actor.session, 'allowPost')
  const parsedId = z.uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsedId.success) agentError(404, 'conversation_not_found', 'Conversation not found')
  const id = parsedId.data
  const parsed = chatInput.safeParse(await readBody(event).catch(() => null))
  if (!parsed.success) agentError(422, 'invalid_message', 'Message content or parameters are invalid')
  const runtime = agentRuntime(event)
  let preparedMessage: Awaited<ReturnType<typeof customerMemoryMessage>> | undefined
  if (parsed.data.action === 'send') {
    // Model restrictions do not change attachment handling in an existing human conversation.
    const { rows: [current] } = parsed.data.message.content.parts.some(part => part.type === 'image')
      ? await runtime.pool.query('SELECT status FROM conversation WHERE id=$1 AND org_id=$2 AND user_id=$3', [id, actor.orgId, actor.customerId])
      : { rows: [] }
    const forModel = aiConfigured && (!current || ['ai_handling', 'closed'].includes(current.status))
    const disconnected = new AbortController()
    const onClose = () => disconnected.abort(new Error('Request disconnected'))
    event.node.res.once('close', onClose)
    try {
      const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(Math.max(0, firstAnswerDeadline - Date.now()))])
      preparedMessage = await customerMemoryMessage(event, { ...parsed.data.message, conversation_id: id, seq: 0, created_at: new Date() }, `${actor.orgId}:${id}`, actor.orgId, false, forModel, signal, true)
        .catch(error => agentError(422, error instanceof ChatImageError ? error.code : 'image_unavailable', 'Please replace or remove the image and try again'))
      signal.throwIfAborted()
    } finally { event.node.res.removeListener('close', onClose) }
    if (!forModel) preparedMessage = undefined
  }
  if (!await checkRateLimit(`widget-messages:${actor.customerId}`, { limit: 20, windowSeconds: 60 })) agentError(429, 'rate_limited', 'Too many messages; try again shortly')
  const execution = await startRun(runtime, id, actor, parsed.data, firstAnswerDeadline)
  if (execution.run && !execution.duplicate) await requestSchedule(event)
  if (execution.duplicate || !execution.run) return {
    accepted: true, duplicate: execution.duplicate, mode: execution.mode,
    item: publicItem(execution.item), run: execution.run ? publicRun(execution.run) : null,
    conversation: { id, title: execution.conversation.title, lastSeq: Number(execution.conversation.last_seq), unread: execution.conversation.unread, handling: handling(execution.conversation.status) },
  }
  const { run, item } = execution
  const replyId = uuidv7()
  const stream = createEventStream(event)
  const stopHeartbeat = startStreamHeartbeat(stream)
  const send = (name: string, data: unknown) => stream.push({ event: name, data: JSON.stringify(data) }).catch(() => {})
  const sendTakeover = (notice: { id: string; seq: number }) => send('handoff', { runId: run.id, lastSeq: notice.seq, handling: 'human' })
  const failAndTakeOver = async (code: string) => {
    const notice = await failRun(runtime, run.id, code)
    if (notice) { await sendTakeover(notice); return true }
    const current = await readStoppedRun(runtime, id, actor.orgId, run.id)
    if (!current) { await send('superseded', { runId: run.id }); return true }
    if (current.status === 'closed') { await send('closed', { runId: run.id, lastSeq: Number(current.last_seq), handling: 'closed' }); return true }
    if (current.notice_id && current.status !== 'ai_handling' && current.content?.parts.some(part => part.type === 'system_event' && part.kind === 'takeover')) {
      await sendTakeover({ id: current.notice_id, seq: Number(current.last_seq) })
      return true
    }
    return false
  }
  const task = (async () => {
    const controller = new AbortController()
    const activity = createRunActivity(new Date(run.deadline_at).getTime())
    const signal = AbortSignal.any([controller.signal, activity.signal])
    let persistedDeadline = new Date(run.deadline_at).getTime()
    let progressWrite = Promise.resolve()
    let lastPersistedAt = Date.now()
    const persistProgress = () => {
      progressWrite = progressWrite.then(async () => {
        signal.throwIfAborted()
        const deadline = activity.deadline()
        if (deadline <= persistedDeadline || Date.now() - lastPersistedAt < 5000) return
        if (!await renewRun(runtime, id, actor, run.id, deadline)) {
          controller.abort()
          signal.throwIfAborted()
        }
        persistedDeadline = deadline
        lastPersistedAt = Date.now()
      })
      return progressWrite
    }
    const answerProgress = (text: string) => { activity.answer(text); return persistProgress() }
    const stopWatching = watchRun(runtime.pool, run.id, persistProgress, () => controller.abort())
    let usage: RunTokenUsage | null = null
    let usageWrite = Promise.resolve()
    const recordUsage = (step: { inputTokens?: number; outputTokens?: number }) => {
      usage = addTokenUsage(usage, step)
      const snapshot = JSON.stringify(usage)
      // Parallel image batches must not overwrite a newer usage total with an older one.
      usageWrite = usageWrite.then(async () => {
        await runtime.pool.query('UPDATE agent_run SET usage=$2 WHERE id=$1', [run.id, snapshot])
          .catch(() => console.warn('[agent] Could not persist token usage', { runId: run.id }))
      })
      return usageWrite
    }
    let handoffUnavailable = false
    let prepared: Awaited<ReturnType<typeof prepareAgent>> | undefined
    try {
      await send('run', { runId: run.id, itemId: replyId, run: publicRun(run) })
      if (!aiConfigured) throw new Error('AI unavailable')
      prepared = await prepareAgent(event, actor, id, run, item, signal, () => {}, unavailable => { handoffUnavailable = !!unavailable; controller.abort() }, recordUsage, preparedMessage, () => controller.abort())
      let firstText = true
      let failed = false
      let executionError: unknown
      const modelController = new AbortController()
      const modelSignal = AbortSignal.any([signal, modelController.signal])
      const output = await prepared.agent.stream([prepared.input], {
        runId: run.id, memory: { thread: id, resource: prepared.resourceId, options: { lastMessages: prepared.historySize } },
        maxSteps: resolveAgentMaxSteps(process.env.AGENT_MAX_STEPS), toolCallConcurrency: 1, abortSignal: modelSignal, onError: error => { failed = true; executionError = error }, onAbort: () => { failed = true },
        onStepFinish: step => recordUsage(step.usage),
      })
      const gate = handoffTextGate()
      const writeText = async (delta: string) => {
        if (!delta) return
        if (firstText) { firstText = false; agentTiming('first_answer', { runId: run.id, elapsedMs: Math.round(performance.now() - started) }) }
        await answerProgress(delta)
        await send('text', { runId: run.id, itemId: replyId, delta })
      }
      const reply = await collectConversationReply(toAISdkStream(output, { from: 'agent', version: 'v7', sendReasoning: false, sendSources: false }), replyId, async chunk => {
        if (chunk.type === 'text-delta') await writeText(gate.push(chunk.delta))
      }).catch(async error => {
        if (error instanceof HandoffProtocolError) {
          modelController.abort()
          console.warn('[agent] Recovering malformed handoff protocol', { runId: run.id, model: process.env.OPENAI_TEXT_MODEL })
          await send('reset', { runId: run.id })
          await prepared!.recoverHandoff()
        }
        throw error
      })
      await writeText(gate.finish())
      if (failed || signal.aborted) throw executionError ?? new Error('Model execution did not complete')
      await runtime.memory.settled()
      let text = reply.message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n\n').trim()
      let parts = await prepared.resultParts()
      const citedIds = [...new Set(parts.flatMap(part => part.type === 'article_reference'
        ? part.articles.map(article => article.article_id) : []))]
      if (text && citedIds.length) {
        const { rows: candidates } = await runtime.pool.query<{ id: string; title: string; content: string }>(
          'SELECT id,title,content FROM help_article WHERE id=ANY($1::uuid[]) AND org_id=$2 AND ai_enabled',
          [citedIds, actor.orgId],
        )
        const question = item.content.parts.filter((part: Part) => part.type === 'text').map((part: { text: string }) => part.text).join('\n')
        const verdict = await verifyHelpCitations(question, text, candidates, {
          timeoutMs: Math.max(1000, Math.min(12000, activity.deadline() - Date.now() - 1000)),
        })
        if (verdict.status === 'unavailable') console.warn('[agent] Citation verification unavailable', { runId: run.id })
        const verifiedIds = new Set(verdict.matches.map(match => match.id))
        parts = keepVerifiedHelpReferences(parts, verifiedIds)
        text = removeUnverifiedAnswerLinks(text, candidates, verifiedIds)
      }
      const content = contentSchema.parse({ parts: [...(text ? [{ type: 'text', text }] : []), ...parts] })
      const { lastSeq, takeover } = await completeRun(runtime, id, actor, run.id, replyId, content, usage)
      await requestSchedule(event)
      agentTiming('run_complete', { runId: run.id, elapsedMs: Math.round(performance.now() - started) })
      await send('finish', { runId: run.id, itemId: replyId, lastSeq, content })
      if (takeover) await sendTakeover(takeover)
    } catch (error) {
      agentTiming('run_failed', { runId: run.id, elapsedMs: Math.round(performance.now() - started), deadlineExpired: activity.signal.aborted, dependencyTimeout: error instanceof AgentDependencyTimeout })
      try {
        if (handoffUnavailable) {
          if (await failAndTakeOver('support_unavailable')) return
          await send('handoff_unavailable', { runId: run.id })
          return
        }
        const imageError = imageExecutionError(error)
        if (imageError) {
          if (await failAndTakeOver(imageError.code)) return
          await send('error', { runId: run.id, code: imageError.code, message: 'Please replace the image and try again.' })
          return
        }
        const { rows: [activeRun] } = await runtime.pool.query('SELECT status,error FROM agent_run WHERE id=$1', [run.id])
        if (activeRun?.error === 'support_unavailable') {
          if (await failAndTakeOver('support_unavailable')) return
          await send('handoff_unavailable', { runId: run.id })
          return
        }
        // A tool may have already handed off or closed the conversation.
        if (aiConfigured && ['running', 'failed'].includes(activeRun?.status)) {
          const timedOut = activity.signal.aborted || activeRun.error === 'ai_timeout' || error instanceof AgentDependencyTimeout || (error instanceof Error && error.name === 'TimeoutError')
          const code = timedOut ? 'ai_timeout' : 'ai_error'
          if (await failAndTakeOver(code)) return
          await send('error', { runId: run.id, code, message: 'The response could not be completed. Please try again.' })
          return
        }
        const feedbackResults = await prepared?.feedbackResults().catch(() => []) ?? []
        try {
          await handoff(runtime, id, actor.orgId, run.id, 'ai_error', true, undefined, feedbackResults, getRequestURL(event).origin)
        } catch {
          if (await failAndTakeOver('support_unavailable')) return
          await send('handoff_unavailable', { runId: run.id })
          return
        }
        const current = await readStoppedRun(runtime, id, actor.orgId, run.id)
        if (!current) { await send('superseded', { runId: run.id }); return }
        const noticePart = current.content?.parts.find(part => part.type === 'system_event' && ['handoff', 'takeover'].includes(part.kind))
        const notice = noticePart?.type === 'system_event' ? noticePart : undefined
        const reason = notice?.reason ?? 'ai_error'
        if (current && current.status !== 'ai_handling') {
          await send(current.status === 'closed' ? 'closed' : 'handoff', { runId: run.id, noticeItemId: notice?.kind === 'handoff' ? current.notice_id ?? undefined : undefined, lastSeq: Number(current.last_seq), handling: handling(current.status), ...(reason === 'ai_error' ? { reason } : notice?.kind === 'handoff' ? { handoffNotice: handoffNotice(reason, notice.rule?.id), customerNotice: notice.customerNotice } : {}) })
        }
        if (current?.status === 'ai_handling') await send('handoff_unavailable', { runId: run.id })
        await requestSchedule(event)
        // A closed conversation may already have reopened. Never let the old run
        // announce a handoff or append a reply into that new round.
      } catch { await send('error', { runId: run.id, code: 'storage_unavailable', message: 'Connection interrupted. Please retry with the same message.' }) }
    } finally { stopHeartbeat(); activity.dispose(); stopWatching(); await stream.close() }
  })()
  event.context.feedlogAgentTask = task
  event.waitUntil(task)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return stream.send()
}
