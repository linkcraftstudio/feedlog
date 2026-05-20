// Augment H3's event.context with the per-request org identifiers populated
// by server/middleware/org-context.ts. Surfaces these to all handlers.

import 'h3'

declare module 'h3' {
  interface H3EventContext {
    orgId?: string
    orgSlug?: string
  }
}

export {}
