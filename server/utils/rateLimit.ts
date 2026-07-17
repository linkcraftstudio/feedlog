// Fixed-window IP rate limiter over Nitro storage (works on both the Node and
// Cloudflare deployments; storage-backed so it holds across instances). Returns
// true if the caller is WITHIN the limit, false once the window is exhausted.
export async function checkRateLimit(
  key: string,
  opts: { limit: number; windowSeconds: number },
): Promise<boolean> {
  try {
    const storage = useStorage('ratelimit')
    const windowMs = opts.windowSeconds * 1000
    const bucket = Math.floor(Date.now() / windowMs)
    const storeKey = `${key}:${bucket}`
    const count = ((await storage.getItem<number>(storeKey)) ?? 0) + 1
    // ttl lets KV-style drivers GC old buckets; memory driver ignores it (fine in dev).
    await storage.setItem(storeKey, count, { ttl: opts.windowSeconds + 5 })
    return count <= opts.limit
  }
  catch {
    // Fail open: a storage-backend hiccup (once a real KV/Redis driver is mounted)
    // must never throw here — the public search must degrade, not 5xx.
    return true
  }
}
