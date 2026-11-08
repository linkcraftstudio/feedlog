// Optional stage durations only; never log message, image, or credential contents.
export function agentTiming(phase: string, details: Record<string, string | number | boolean | undefined> = {}) {
  if (process.env.AGENT_TIMING === 'true') console.info('[agent-timing]', JSON.stringify({ phase, ...details }))
}
