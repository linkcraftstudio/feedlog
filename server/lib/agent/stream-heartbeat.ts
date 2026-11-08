interface HeartbeatStream {
  push(message: { event: string; data: string }): Promise<void>
  onClosed(callback: () => void): void
}

// Keep idle proxies connected without advancing the first-answer or idle deadline.
export function startStreamHeartbeat(stream: HeartbeatStream) {
  let writing = false
  const timer = setInterval(() => {
    if (writing) return
    writing = true
    void stream.push({ event: 'heartbeat', data: '{}' })
      .catch(stop)
      .finally(() => { writing = false })
  }, 10_000)
  function stop() { clearInterval(timer) }
  stream.onClosed(stop)
  return stop
}
