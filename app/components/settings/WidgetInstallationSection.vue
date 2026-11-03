<script setup lang="ts">
import { toast } from 'vue-sonner'

const props = defineProps<{ baseUrl: string; enabled: boolean; saving: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useI18n()
const copiedKey = ref<string | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | undefined

async function copy(key: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copiedKey.value = null }, 1500)
  }
  catch {
    toast.error(t('settings.widget.copyFailed'))
  }
}
onBeforeUnmount(() => clearTimeout(copyTimer))

const basicSnippet = computed(() => `import { createWidget } from '@feedlog/widget'

createWidget({
  baseUrl: ${JSON.stringify(props.baseUrl)},
  theme: 'auto',
})`)

const serverSnippet = `import jwt from 'jsonwebtoken'

// Keep this endpoint behind your own sign-in. Never expose the secret.
app.get('/api/feedlog-token', requireSignIn, (req, res) => {
  const token = jwt.sign(
    {
      email: req.user.email,
      name: req.user.name,
      picture: req.user.avatar,
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    },
    process.env.FEEDLOG_SSO_SECRET,
    { algorithm: 'HS256' },
  )
  res.json({ token })
})`

const authSnippet = computed(() => `import { createWidget } from '@feedlog/widget'

createWidget({
  baseUrl: ${JSON.stringify(props.baseUrl)},
  auth: {
    getToken: async () => {
      const res = await fetch('/api/feedlog-token')
      if (res.status === 401) return null // Signed out.
      if (!res.ok) throw new Error('temporary failure')
      return (await res.json()).token ?? null
    },
    // The promise must settle after success, cancellation, or failure.
    login: () => openYourLoginModalAndWaitUntilClosed(),
  },
  theme: 'auto',
})`)

const customEntrySnippet = computed(() => `import { createWidget, openWidget } from '@feedlog/widget'

createWidget({
  baseUrl: ${JSON.stringify(props.baseUrl)},
})

document.querySelector('#help-entry')?.addEventListener('click', openWidget)`)

const steps = computed(() => [
  { key: 'package', title: t('settings.widget.packageLabel'), code: 'pnpm add @feedlog/widget' },
  { key: 'basic', title: t('settings.widget.snippetLabel'), code: basicSnippet.value },
])
const authSteps = computed(() => [
  { key: 'server', title: t('settings.widget.serverLabel'), code: serverSnippet },
  { key: 'auth', title: t('settings.widget.clientLabel'), code: authSnippet.value },
])
</script>

<template>
  <section
    class="rounded-xl border border-border bg-card overflow-hidden"
    data-widget-section="installation"
  >
    <div class="px-6 py-5 border-b border-border flex flex-wrap items-start justify-between gap-4">
      <div>
        <h3 class="font-heading font-bold text-sm">
          {{ $t('settings.widget.installSection') }}
        </h3>
        <p class="text-xs text-muted-foreground mt-0.5">
          {{ $t('settings.widget.installDesc') }}
        </p>
      </div>
      <div class="flex items-center gap-2.5">
        <Switch
          id="widget-enabled"
          :model-value="enabled"
          :disabled="saving"
          @update:model-value="emit('toggle')"
        />
        <label
          for="widget-enabled"
          class="text-xs font-semibold"
        >{{ $t('settings.widget.enabledLabel') }}</label>
      </div>
    </div>
    <div class="px-6 py-6 space-y-5 min-w-0">
      <div>
        <p class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          {{ $t('settings.widget.baseUrlLabel') }}
        </p>
        <div class="mt-2 flex items-center gap-2">
          <code class="flex-1 min-w-0 break-all text-xs font-mono px-2.5 py-2 rounded-md bg-muted border border-border">{{ baseUrl }}</code>
          <button
            type="button"
            class="size-9 rounded-md hover:bg-secondary flex items-center justify-center shrink-0 text-muted-foreground"
            :aria-label="$t('settings.widget.copy')"
            @click="copy('url', baseUrl)"
          >
            <Icon
              :name="copiedKey === 'url' ? 'lucide:check' : 'lucide:copy'"
              size="14"
            />
          </button>
        </div>
        <p class="text-[11px] text-muted-foreground mt-1.5">
          {{ $t('settings.widget.enabledHint') }}
        </p>
      </div>
      <details class="group/install">
        <summary class="cursor-pointer text-xs font-semibold text-primary">
          {{ $t('settings.widget.installInstructions') }}
        </summary>
        <div class="pt-5 space-y-5">
          <div
            v-for="step in steps"
            :key="step.key"
          >
            <div class="flex items-center justify-between gap-3">
              <p class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {{ step.title }}
              </p>
              <button
                type="button"
                class="h-7 px-2.5 rounded-md border border-border text-[11px] font-semibold hover:bg-secondary"
                data-fdl-action="widget_snippet_copy"
                @click="copy(step.key, step.code)"
              >
                {{ copiedKey === step.key ? $t('settings.widget.copied') : $t('settings.widget.copy') }}
              </button>
            </div>
            <pre class="mt-2 px-4 py-3 rounded-lg bg-muted/40 border border-border overflow-x-auto text-xs font-mono leading-relaxed"><code>{{ step.code }}</code></pre>
          </div>
          <p class="text-[11px] text-muted-foreground">
            {{ $t('settings.widget.guestInstallHint') }}
          </p>
          <details class="border-t border-border pt-4">
            <summary class="cursor-pointer text-xs font-semibold">
              {{ $t('settings.widget.authInstructions') }}
            </summary>
            <div class="pt-4 space-y-5">
              <p class="text-[11px] text-muted-foreground">
                {{ $t('settings.widget.serverHint') }}
              </p>
              <div
                v-for="step in authSteps"
                :key="step.key"
              >
                <div class="flex items-center justify-between gap-3">
                  <p class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                    {{ step.title }}
                  </p>
                  <button
                    type="button"
                    class="h-7 px-2.5 rounded-md border border-border text-[11px] font-semibold hover:bg-secondary"
                    data-fdl-action="widget_snippet_copy"
                    @click="copy(step.key, step.code)"
                  >
                    {{ copiedKey === step.key ? $t('settings.widget.copied') : $t('settings.widget.copy') }}
                  </button>
                </div>
                <pre class="mt-2 px-4 py-3 rounded-lg bg-muted/40 border border-border overflow-x-auto text-xs font-mono leading-relaxed"><code>{{ step.code }}</code></pre>
              </div>
            </div>
          </details>
          <details class="border-t border-border pt-4">
            <summary class="cursor-pointer text-xs font-semibold">
              {{ $t('settings.widget.customEntryInstructions') }}
            </summary>
            <p class="text-[11px] text-muted-foreground mt-4">
              {{ $t('settings.widget.customEntryHint') }}
            </p>
            <div class="flex justify-end mt-3">
              <button
                type="button"
                class="h-7 px-2.5 rounded-md border border-border text-[11px] font-semibold hover:bg-secondary"
                data-fdl-action="widget_snippet_copy"
                @click="copy('custom-entry', customEntrySnippet)"
              >
                {{ copiedKey === 'custom-entry' ? $t('settings.widget.copied') : $t('settings.widget.copy') }}
              </button>
            </div>
            <pre class="mt-2 px-4 py-3 rounded-lg bg-muted/40 border border-border overflow-x-auto text-xs font-mono leading-relaxed"><code>{{ customEntrySnippet }}</code></pre>
          </details>
        </div>
      </details>
      <a
        href="https://help.feedlog.ai/developers/widget"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline underline-offset-4"
      >
        {{ $t('settings.widget.installGuide') }}
        <Icon
          name="lucide:arrow-up-right"
          size="14"
          aria-hidden="true"
        />
      </a>
    </div>
  </section>
</template>
