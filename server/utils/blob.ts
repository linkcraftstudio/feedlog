// Blob storage abstraction — registry pattern (parallel to email.ts).
// Auto-imported by Nitro; `blobStorage` is the resolved BlobStorage,
// forwarded lazily to whichever provider is registered. Named to avoid
// shadowing `@nuxthub/blob`'s own `blob` / `ensureBlob` server
// auto-imports (which would trigger a Nitro duplicate-import warning).
// The default provider registers in server/plugins/blob.ts; additional
// providers (S3, R2, custom OSS) can register via `registerBlobProvider()`
// from their own Nitro plugin.

import type { BlobStorage } from '@nuxthub/core/blob'

export interface BlobProvider {
  name: string
  storage: BlobStorage
}

// --- Registry ---
const providers = new Map<string, BlobProvider>()

export function registerBlobProvider(provider: BlobProvider) {
  providers.set(provider.name, provider)
}

export function resolveBlobProvider(): BlobProvider {
  const config = useRuntimeConfig()
  const preferred = config.blobProvider as string | undefined

  // 1. Explicit pick via runtime config
  if (preferred && providers.has(preferred))
    return providers.get(preferred)!

  // 2. Any non-default provider wins over the built-in nuxthub fallback,
  // so dropping in S3 / R2 / OSS doesn't require setting NUXT_BLOB_PROVIDER
  // explicitly.
  for (const [name, provider] of providers) {
    if (name !== 'nuxthub') return provider
  }
  if (providers.has('nuxthub')) return providers.get('nuxthub')!

  throw new Error('No blob provider registered')
}

// Forward BlobStorage methods lazily so top-level `import { blobStorage }`
// works regardless of plugin registration order. Re-resolves every access
// so providers with rotating credentials can swap their underlying storage.
export const blobStorage: BlobStorage = new Proxy({} as BlobStorage, {
  get(_, prop) {
    const instance = resolveBlobProvider().storage
    const value = (instance as any)[prop]
    return typeof value === 'function' ? value.bind(instance) : value
  },
})
