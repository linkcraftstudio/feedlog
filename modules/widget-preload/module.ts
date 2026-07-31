import { defineNuxtModule, addServerPlugin, createResolver } from '@nuxt/kit'

// The frame is served as an SPA shell (`ssr: false`), which advertises only
// the entry chunk: the route's own chunk, the chunks it shares and its
// stylesheet are each discovered a round trip after the previous one has run.
// Server code cannot read the client manifest (`#build/*` is barred from the
// nitro runtime), so resolve those chunk chains here at build time and hand
// them to the runtime plugin as a virtual module. `build:manifest` never fires
// in dev, which leaves the list empty and the plugin inert.

const ROUTE_MODULE_RE = /(^|\/)pages\/widget\/embed\.vue$/
// Every layer contributes one vueI18n config, and the i18n plugin — not the
// route — imports them, so they hang off no chunk the route can reach.
const I18N_CONFIG_RE = /(^|\/)i18n\.config\.(ts|js|mjs)$/

interface ManifestEntry {
  file: string
  css?: string[]
  imports?: string[]
  isEntry?: boolean
}

interface Hint {
  file: string
  rel: 'modulepreload' | 'preload'
  as?: string
}

function collectModules(manifest: Record<string, ManifestEntry>, id: string, seen: Set<string>) {
  if (seen.has(id) || !manifest[id]) return
  seen.add(id)
  for (const imported of manifest[id]!.imports ?? []) {
    collectModules(manifest, imported, seen)
  }
}

function collectFiles(manifest: Record<string, ManifestEntry>, ids: Set<string>): string[] {
  const files: string[] = []
  for (const id of ids) {
    const entry = manifest[id]!
    if (entry.file) files.push(entry.file)
    files.push(...entry.css ?? [])
  }
  return files
}

function collectHints(manifest: Record<string, ManifestEntry>): Hint[] {
  const routeId = Object.keys(manifest).find(id => ROUTE_MODULE_RE.test(id))
  if (!routeId) return []

  const entryModules = new Set<string>()
  for (const [id, entry] of Object.entries(manifest)) {
    if (entry.isEntry) collectModules(manifest, id, entryModules)
  }
  // Whatever the entry pulls in is already linked in the shell.
  const shipped = new Set(collectFiles(manifest, entryModules))

  const needed = new Set<string>()
  collectModules(manifest, routeId, needed)
  for (const id of Object.keys(manifest)) {
    if (I18N_CONFIG_RE.test(id)) collectModules(manifest, id, needed)
  }

  const hints: Hint[] = []
  for (const file of collectFiles(manifest, needed)) {
    if (shipped.has(file)) continue
    shipped.add(file)
    hints.push(file.endsWith('.css')
      ? { file, rel: 'preload', as: 'style' }
      : { file, rel: 'modulepreload', as: 'script' })
  }
  return hints
}

export default defineNuxtModule({
  meta: { name: 'widget-preload' },
  setup(_options, nuxt) {
    let hints: Hint[] = []

    nuxt.hook('build:manifest', (manifest) => {
      hints = collectHints(manifest as Record<string, ManifestEntry>)
    })

    // Read back when Nitro bundles, which is after the client build has filled
    // the list in.
    nuxt.hook('nitro:config', (nitro) => {
      nitro.virtual = {
        ...nitro.virtual,
        '#widget-preload/hints': () => `export default ${JSON.stringify(hints)}`,
      }
    })

    const { resolve } = createResolver(import.meta.url)
    addServerPlugin(resolve('./runtime/server/plugins/widget-embed-preload'))
  },
})
