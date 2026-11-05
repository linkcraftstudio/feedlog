export function resolveAgentMaxSteps(value: string | undefined): number {
  const defaultSteps = 12
  if (value === undefined) return defaultSteps

  const normalized = value.trim()
  const steps = Number(normalized)
  return /^\d+$/.test(normalized) && Number.isSafeInteger(steps) && steps > 0
    ? steps
    : defaultSteps
}
