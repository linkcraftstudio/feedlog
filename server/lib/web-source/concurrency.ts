// Shared by queue claiming and wake scheduling. Bounds in-flight page pipelines
// across instances using the same database, including remote model requests.
export function webSourceConcurrency() {
  const value = Number(process.env.WEB_SOURCE_CONCURRENCY ?? 8)
  return Number.isInteger(value) && value >= 1 && value <= 8 ? value : 8
}

export const WEB_SOURCE_CLAIM_LOCK = 71839002
