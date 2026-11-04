<script setup lang="ts">
import { toast } from 'vue-sonner'
import { widgetAgentPrompt } from '#layers/feedlog/app/utils/widget-agent-prompt'
import AgentCodexMark from '#layers/feedlog/app/components/settings/AgentCodexMark.vue'

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

// The recommended path: the user's own coding agent does the integration in
// their repository, so the page hands over one prompt carrying this workspace's URL.
const portalOrg = usePortalOrg()
// Codex has its own component: the icon set only carries its mark in black.
const AGENTS = [
  { name: 'Codex', icon: null },
  { name: 'Claude Code', icon: 'logos:claude-icon' },
  { name: 'Cursor', icon: 'logos:cursor-icon' },
]
const agentPrompt = computed(() => widgetAgentPrompt(props.baseUrl, {
  widgetOn: props.enabled,
  guestFeedbackOn: portalOrg.value.guest.allowPost,
}))

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
        <!-- What the switch does only matters once it is off: then the widget stays
             hidden even on a site where it is installed. -->
        <p
          v-if="enabled"
          class="text-xs text-muted-foreground mt-0.5"
        >
          {{ $t('settings.widget.installDesc') }}
        </p>
        <p
          v-else
          class="text-xs font-medium text-amber-700 dark:text-amber-400 mt-0.5 flex items-center gap-1.5"
          data-widget-disabled-hint
        >
          <Icon
            name="lucide:eye-off"
            size="13"
            aria-hidden="true"
          />
          {{ $t('settings.widget.enabledHint') }}
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
      <!-- Two paths, agent first: most teams now hand integration work to a coding
           agent, and the prompt carries everything the manual steps below show. -->
      <div data-widget-agent-install>
        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h4 class="font-heading text-sm font-bold">
            {{ $t('settings.widget.agentTitle') }}
          </h4>
          <!-- The agents the copy names, in colour so the section reads at a glance
               as the agent path; the names stay in the text below for anyone who
               doesn't know the marks. Nudged down a pixel to sit on the heading's
               optical centre rather than its line box. -->
          <ul class="flex items-center gap-1.5 translate-y-px">
            <!-- flex: an Icon renders as an inline box, which would give its row the
                 text line height and lift the mark above the Codex SVG. -->
            <li
              v-for="agent in AGENTS"
              :key="agent.name"
              class="flex"
              :title="agent.name"
            >
              <AgentCodexMark
                v-if="!agent.icon"
                class="block size-4"
                role="img"
                :aria-label="agent.name"
              />
              <Icon
                v-else
                :name="agent.icon"
                size="16"
                class="block"
                :aria-label="agent.name"
              />
            </li>
          </ul>
        </div>
        <button
          type="button"
          class="mt-3 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-bold hover:opacity-90 transition-opacity inline-flex items-center gap-1.5"
          data-fdl-action="widget_agent_prompt_copy"
          data-widget-agent-copy
          @click="copy('agent', agentPrompt)"
        >
          <Icon
            :name="copiedKey === 'agent' ? 'lucide:check' : 'lucide:sparkles'"
            size="15"
          />
          {{ copiedKey === 'agent' ? $t('settings.widget.copied') : $t('settings.widget.agentCopy') }}
        </button>
        <p class="mt-2.5 text-xs leading-relaxed text-muted-foreground">
          {{ $t('settings.widget.agentBody') }}
        </p>
      </div>
      <!-- Collapsed by default so the agent prompt stays the obvious first step. -->
      <details class="group/manual border-t border-border pt-5">
        <summary class="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <div class="flex items-center gap-1.5">
            <h4 class="font-heading text-sm font-bold">
              {{ $t('settings.widget.installInstructions') }}
            </h4>
            <Icon
              name="lucide:chevron-right"
              size="15"
              class="text-muted-foreground transition-transform group-open/manual:rotate-90"
              aria-hidden="true"
            />
          </div>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ $t('settings.widget.manualDesc') }}
          </p>
        </summary>
        <div class="pt-5 space-y-5">
          <!-- The snippets below already carry it; shown for setups that keep it in config. -->
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span class="text-muted-foreground">{{ $t('settings.widget.baseUrlLabel') }}</span>
            <code class="font-mono px-1.5 py-0.5 rounded bg-muted border border-border break-all">{{ baseUrl }}</code>
            <button
              type="button"
              class="size-6 rounded hover:bg-secondary grid place-items-center text-muted-foreground"
              :aria-label="$t('settings.widget.copy')"
              @click="copy('url', baseUrl)"
            >
              <Icon
                :name="copiedKey === 'url' ? 'lucide:check' : 'lucide:copy'"
                size="13"
              />
            </button>
          </div>
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
