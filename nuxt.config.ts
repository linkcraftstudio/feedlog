// https://nuxt.com/docs/api/configuration/nuxt-config
import { createResolver } from '@nuxt/kit'

const resolver = createResolver(import.meta.url)

export default defineNuxtConfig({
  // `$meta.name` makes Nuxt auto-generate a `#layers/feedlog` alias pointing
  // at this layer's rootDir, whether this project runs standalone (`cd` in,
  // `pnpm dev`) or is embedded as a consumer's layer (e.g. under
  // `<your-app>/layers/feedlog/`). Official:
  // https://nuxt.com/docs/4.x/guide/going-further/layers
  //
  // Required for the standalone case — in the consumer case Nuxt's
  // auto-scan of `~~/layers/<dirname>/` would also generate the same alias
  // from the directory name, but we keep `$meta.name` explicit so standalone
  // runs don't break and the layer's identity isn't tied to a particular
  // directory name.
  $meta: { name: 'feedlog' },

  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  // NOTE: `#shared` is owned by the active Nuxt instance (the consumer), so
  // a downstream app extending this layer can place its own `shared/types/*`
  // and import via `#shared/`. This layer's own layer-local references go
  // through `#layers/feedlog/...` (auto-generated from $meta.name above).

  // app/stores/ is NOT in Nuxt's layer auto-merge list, so when feedlog is
  // consumed as a layer, `useBoardStore` etc. would not auto-import. Force
  // registration with an absolute path so Pinia stores work in both standalone
  // and extended contexts.
  imports: {
    dirs: [resolver.resolve('./app/stores')],
  },

  app: {
    head: {
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' },
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon.png' },
        { rel: 'shortcut icon', href: '/favicon.ico' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
      ],
    },
  },

  site: {
    name: 'Feedlog',
  },

  components: [
    { path: resolver.resolve('./app/components'), pathPrefix: false },
  ],

  modules: [
    '@nuxt/eslint',
    '@nuxt/fonts',
    '@nuxt/icon',
    '@nuxt/image',
    '@nuxtjs/i18n',
    '@nuxtjs/seo',
    '@pinia/nuxt',
    '@nuxtjs/tailwindcss',
    'shadcn-nuxt',
    '@nuxthub/core',
    // CF-only bootstrap module: adds a /setup page + /api/_migrate endpoints
    // so the one-click Cloudflare Deploy Button can finish DB migrations on
    // first request. All handlers no-op (404) under non-CF presets.
    // Resolver path keeps layer-consumer usage working.
    resolver.resolve('./modules/cf-setup/module'),
    // Node / Docker only: registers an S3-compatible blob provider at
    // runtime when S3_* env vars are set. Skipped on cloudflare-module
    // and vercel presets where NuxtHub's R2 / Vercel Blob driver applies.
    resolver.resolve('./modules/blob-s3/module'),
  ],
  shadcn: {
    prefix: '',
    componentDir: resolver.resolve('./app/components/ui'),
  },
  fonts: {
    families: [
      {
        name: 'Inter',
        provider: 'google',
        weights: [400, 500, 600, 700],
      },
    ],
  },
  i18n: {
    locales: [
      { code: 'en', language: 'en-US' },
    ],
    defaultLocale: 'en',
  },
  hub: {
    blob: true,
  },

  build: {
    transpile: ['reka-ui'],
  },

  nitro: {
    // Keep CF Workers' native node:fs / path / process available at runtime so
    // the cf-setup module can read bundled migration files via `/bundle/...`.
    // Without this, Nitro's unenv stub shadows them, reads return empty, and
    // the state classifier never leaves `bootstrap`.
    unenv: {
      external: ['node:fs', 'node:fs/promises', 'node:path', 'node:process'],
    },
  },

  vite: {
    ssr: {
      // Exclude md-editor-v3 from SSR bundle — it's browser-only and very large (~2MB)
      external: ['md-editor-v3'],
    },
  },

  ogImage: {
    enabled: false,
  },

  runtimeConfig: {
    public: {
      uploadPrefix: process.env.NUXT_PUBLIC_UPLOAD_PREFIX || 'uploads',
    },
  },
})
