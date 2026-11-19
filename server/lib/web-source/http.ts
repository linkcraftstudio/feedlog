import type { H3Event } from 'h3'
import { withHelpPool } from '../help-search/runtime'
import { requestSchedule } from '../inbox/platform'
import { logWebSourceFailure, publicWebSourceError } from './failure'
import type { Pool } from 'pg'

export async function webSourceRequest<T>(event: H3Event, action: (pool: Pool) => Promise<T>, changed = false) {
  try {
    const result = await withHelpPool(event, action)
    if (changed) event.waitUntil(requestSchedule(event))
    return result
  } catch (error) {
    logWebSourceFailure(error, { stage: 'request', path: event.path.split('?')[0] })
    throw publicWebSourceError(error)
  }
}
