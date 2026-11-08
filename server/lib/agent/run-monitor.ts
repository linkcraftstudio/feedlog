import type { Pool } from 'pg'

type Watcher = { active: () => Promise<void>; stopped: () => void }
type Monitor = { watches: Map<string, Watcher>; timer: ReturnType<typeof setInterval>; checking: boolean }
const monitors = new WeakMap<Pool, Monitor>()

// One short status query per process/pool, not one per active conversation.
// Individual timers can otherwise saturate the pool before real work completes.
export function watchRun(pool: Pool, id: string, active: () => Promise<void>, stopped: () => void) {
  let monitor = monitors.get(pool)
  if (!monitor) {
    const watches = new Map<string, Watcher>()
    const state: Monitor = { watches, timer: undefined!, checking: false }
    state.timer = setInterval(async () => {
      if (state.checking || !watches.size) return
      state.checking = true
      const snapshot = [...watches]
      try {
        const { rows } = await pool.query<{ id: string }>("SELECT id FROM agent_run WHERE id=ANY($1::uuid[]) AND status='running'", [snapshot.map(([id]) => id)])
        const running = new Set(rows.map(row => row.id))
        await Promise.all(snapshot.map(async ([runId, watcher]) => {
          if (watches.get(runId) !== watcher) return
          if (!running.has(runId)) watcher.stopped()
          else { try { await watcher.active() } catch { watcher.stopped() } }
        }))
      } catch {
        for (const [runId, watcher] of snapshot) if (watches.get(runId) === watcher) watcher.stopped()
      } finally { state.checking = false }
    }, 1000)
    state.timer.unref?.()
    monitors.set(pool, state)
    monitor = state
  }
  const watcher = { active, stopped }
  monitor.watches.set(id, watcher)
  const state = monitor
  return () => {
    if (state.watches.get(id) === watcher) state.watches.delete(id)
    if (!state.watches.size) { clearInterval(state.timer); if (monitors.get(pool) === state) monitors.delete(pool) }
  }
}
