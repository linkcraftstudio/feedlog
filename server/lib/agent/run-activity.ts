// The initial deadline bounds the first visible answer. Only nonempty answer
// text switches to/renews the inactivity window; background work never does.
export const RUN_IDLE_MS = 120_000

export function createRunActivity(initialDeadline: number, idleMs = RUN_IDLE_MS) {
  const controller = new AbortController()
  let expiresAt = initialDeadline
  let disposed = false
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new Error('AI response stalled')), Math.max(1, expiresAt - Date.now()))
  }
  arm()
  return {
    signal: controller.signal,
    deadline: () => expiresAt,
    answer(text: string) {
      if (!text.length) return
      if (disposed || controller.signal.aborted) return
      // Late output must not resurrect an expired run before its timer fires.
      if (Date.now() >= expiresAt) { controller.abort(new Error('AI response stalled')); return }
      expiresAt = Date.now() + idleMs
      arm()
    },
    dispose() { disposed = true; clearTimeout(timer) },
  }
}
