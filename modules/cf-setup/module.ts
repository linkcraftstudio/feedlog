import { cp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addServerHandler, createResolver, defineNuxtModule } from '@nuxt/kit'

// Patch module for Cloudflare Workers.
//
// CF Workers have no real "startup phase": async work at module init is not
// tied to the fetch lifecycle and dies when the first request returns. That
// breaks the usual "migrate DB before listen" pattern. This module adds a
// CF-only /setup page + /api/_migrate endpoints + a request middleware that
// detects unmigrated state and redirects to /setup.
//
// Why always register instead of gating on preset at setup() time: on CF
// Workers Builds, NITRO_PRESET isn't set as an env var and the Nitro preset
// ends up on nuxt.options only after @nuxthub/core resolves it at a later
// hook than where our module.setup() runs. Registering unconditionally and
// short-circuiting inside each handler via `import.meta.preset` is more
// robust — the cost is a few KB of dead code on non-CF bundles.

export default defineNuxtModule({
  meta: {
    name: 'cf-setup',
    configKey: 'cfSetup',
  },
  setup(_options, nuxt) {
    const resolver = createResolver(import.meta.url)

    // wrangler bundles the Nitro chunk to the root, so its ../../wasm import
    // resolves to nothing. Keep the Wasm next to the chunk and import it there.
    nuxt.hook('nitro:init', (nitro) => {
      nitro.hooks.hook('compiled', async () => {
        if (!nitro.options.preset.startsWith('cloudflare')) return
        const chunkDir = join(nitro.options.output.serverDir, 'chunks/nitro')
        const chunk = join(chunkDir, 'nitro.mjs')
        await cp(join(nitro.options.output.serverDir, 'wasm'), join(chunkDir, 'wasm'), { recursive: true })
        await writeFile(chunk, (await readFile(chunk, 'utf8')).replaceAll('../../wasm/', './wasm/'))
      })
    })

    addServerHandler({
      route: '/setup',
      method: 'get',
      handler: resolver.resolve('./runtime/server/routes/setup.get.ts'),
    })

    addServerHandler({
      route: '/api/_migrate/status',
      method: 'get',
      handler: resolver.resolve('./runtime/server/api/_migrate/status.get.ts'),
    })

    addServerHandler({
      route: '/api/_migrate/run',
      method: 'post',
      handler: resolver.resolve('./runtime/server/api/_migrate/run.post.ts'),
    })

    addServerHandler({
      handler: resolver.resolve('./runtime/server/middleware/migrate-check.ts'),
      middleware: true,
    })
  },
})
