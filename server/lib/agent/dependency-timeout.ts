export class AgentDependencyTimeout extends Error {
  constructor() { super('Agent dependency timed out') }
}

// Read-only dependencies may not hold up the answer indefinitely. Late results
// are ignored; provider requests also have their own abort/transport timeout.
export async function withDependencyTimeout<T>(work: () => Promise<T>, signal: AbortSignal, timeoutMs = 5000): Promise<T> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout>
  let abort: () => void = () => {}
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work() }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AgentDependencyTimeout()), timeoutMs)
      abort = () => reject(signal.reason ?? new Error('Run aborted'))
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { clearTimeout(timer!); signal.removeEventListener('abort', abort) }
}
