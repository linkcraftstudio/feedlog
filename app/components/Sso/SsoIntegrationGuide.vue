<script setup lang="ts">
// Integration guide: endpoint + query params + JWT payload + signing snippet +
// TTL guidance. Pure reference content for the customer's developer.
//
// The endpoint is derived from the CURRENT origin — i.e. whatever host is
// serving this dashboard — so the integrator always copies a working URL.

const origin = useRequestURL().origin
const { t } = useI18n()
const endpoint = computed(() => `${origin}/api/sso/jwt`)

const queryParams = computed(() => [
  { name: 'jwt', required: true, desc: t('dashboard.sso.guideParamJwt') },
  { name: 'return_to', required: false, desc: t('dashboard.sso.guideParamReturnTo') },
])

const payloadFields = computed(() => [
  { name: 'email', required: true, desc: t('dashboard.sso.guidePayloadEmail') },
  { name: 'name', required: true, desc: t('dashboard.sso.guidePayloadName') },
  { name: 'picture', required: false, desc: t('dashboard.sso.guidePayloadPicture') },
  { name: 'exp', required: true, desc: t('dashboard.sso.guidePayloadExp') },
])

const snippet = computed(() => `import jwt from 'jsonwebtoken'

// Pre-sign at render time (page load / widget init), NOT on click —
// this avoids a network round-trip when the user follows the link.
function buildFeedbackUrl(user, returnTo = '/') {
  const token = jwt.sign(
    {
      email:   user.email,   // required — identity key
      name:    user.name,    // required — display name
      picture: user.avatar,  // optional — avatar URL
      exp: Math.floor(Date.now() / 1000) + 60 * 60, // required — ~1h recommended
    },
    process.env.FEEDLOG_SSO_SECRET, // one of this workspace's enabled secrets
    { algorithm: 'HS256' },
  )

  const base = '${endpoint.value}'
  return \`\${base}?jwt=\${token}&return_to=\${encodeURIComponent(returnTo)}\`
}`)

const copiedKey = ref<string | null>(null)
function copy(key: string, text: string) {
  navigator.clipboard?.writeText(text)
  copiedKey.value = key
  setTimeout(() => { copiedKey.value = null }, 1500)
}
</script>

<template>
  <div class="space-y-6">
    <!-- Endpoint -->
    <section class="rounded-xl border border-border bg-card overflow-hidden">
      <div class="px-5 py-3 border-b border-border">
        <h3 class="font-heading font-bold text-sm">{{ $t('dashboard.sso.guideEndpoint') }}</h3>
        <p class="text-[11px] text-muted-foreground mt-0.5">{{ $t('dashboard.sso.guideEndpointDesc') }}</p>
      </div>
      <div class="px-5 py-4 space-y-4">
        <div class="flex items-center gap-2">
          <span class="text-[10px] font-bold uppercase tracking-wider bg-secondary text-primary px-1.5 py-0.5 rounded shrink-0">GET</span>
          <code class="flex-1 min-w-0 truncate text-xs font-mono px-2.5 py-1.5 rounded-md bg-muted border border-border">{{ endpoint }}</code>
          <button
            class="w-8 h-8 rounded-md hover:bg-secondary transition-colors flex items-center justify-center shrink-0"
            :class="copiedKey === 'endpoint' ? 'text-[var(--status-done)]' : 'text-muted-foreground'"
            @click="copy('endpoint', endpoint)"
          >
            <Icon :name="copiedKey === 'endpoint' ? 'lucide:check' : 'lucide:copy'" size="14" />
          </button>
        </div>

        <!-- Query params -->
        <div>
          <p class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">{{ $t('dashboard.sso.guideQueryParams') }}</p>
          <ul class="divide-y divide-border rounded-lg border border-border overflow-hidden">
            <li v-for="q in queryParams" :key="q.name" class="px-3 py-2.5 flex items-start gap-3 bg-background">
              <code class="text-xs font-mono font-bold text-foreground shrink-0 w-[88px]">{{ q.name }}</code>
              <span
                class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                :class="q.required ? 'bg-secondary text-primary' : 'bg-muted text-muted-foreground'"
              >{{ q.required ? $t('dashboard.sso.required') : $t('dashboard.sso.optional') }}</span>
              <span class="text-xs text-muted-foreground leading-snug">{{ q.desc }}</span>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- JWT payload -->
    <section class="rounded-xl border border-border bg-card overflow-hidden">
      <div class="px-5 py-3 border-b border-border">
        <h3 class="font-heading font-bold text-sm">{{ $t('dashboard.sso.guideJwtPayload') }}</h3>
        <p class="text-[11px] text-muted-foreground mt-0.5">{{ $t('dashboard.sso.guideJwtPayloadDesc') }}</p>
      </div>
      <ul class="divide-y divide-border">
        <li v-for="f in payloadFields" :key="f.name" class="px-5 py-2.5 flex items-start gap-3">
          <code class="text-xs font-mono font-bold text-foreground shrink-0 w-[110px]">{{ f.name }}</code>
          <span
            class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
            :class="f.required ? 'bg-secondary text-primary' : 'bg-muted text-muted-foreground'"
          >{{ f.required ? $t('dashboard.sso.required') : $t('dashboard.sso.optional') }}</span>
          <span class="text-xs text-muted-foreground leading-snug">{{ f.desc }}</span>
        </li>
      </ul>
    </section>

    <!-- Signing example -->
    <section class="rounded-xl border border-border bg-card overflow-hidden">
      <div class="px-5 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h3 class="font-heading font-bold text-sm">{{ $t('dashboard.sso.guideSignTitle') }}</h3>
          <p class="text-[11px] text-muted-foreground mt-0.5">{{ $t('dashboard.sso.guideSignDesc') }}</p>
        </div>
        <button
          class="h-8 px-2.5 rounded-md border border-border bg-background hover:bg-secondary transition-colors flex items-center gap-1.5 text-xs font-semibold"
          :class="copiedKey === 'snippet' ? 'text-[var(--status-done)]' : 'text-muted-foreground'"
          @click="copy('snippet', snippet)"
        >
          <Icon :name="copiedKey === 'snippet' ? 'lucide:check' : 'lucide:copy'" size="13" />
          {{ copiedKey === 'snippet' ? $t('dashboard.sso.copied') : $t('dashboard.sso.copy') }}
        </button>
      </div>
      <pre class="px-5 py-4 overflow-x-auto text-xs font-mono leading-relaxed text-foreground bg-muted/40"><code>{{ snippet }}</code></pre>
    </section>

    <!-- TTL guidance -->
    <div class="flex items-start gap-2.5 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900">
      <Icon name="lucide:clock" size="15" class="mt-0.5 shrink-0 text-amber-600" />
      <div class="text-xs leading-relaxed">
        <p class="font-bold">{{ $t('dashboard.sso.guideTtlPre') }}<code class="font-mono">exp</code>{{ $t('dashboard.sso.guideTtlPost') }}</p>
        <p class="mt-1">
          {{ $t('dashboard.sso.guideTtlBody') }}
        </p>
      </div>
    </div>

    <!-- How it works footnote -->
    <p class="text-[11px] text-muted-foreground leading-relaxed">
      <Icon name="lucide:info" size="11" class="inline mr-1" />
      {{ $t('dashboard.sso.guideMatchedByPre') }}<span class="font-semibold">{{ $t('dashboard.sso.guideMatchedByEmail') }}</span>{{ $t('dashboard.sso.guideMatchedByPost') }}
    </p>
  </div>
</template>
