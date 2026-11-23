<script setup lang="ts">
import { useClipboard, useLocalStorage } from '@vueuse/core'
// Read the browser preference after hydration so the initial server and client markup match.
const open = useLocalStorage('feedlog:mcp:skills-expanded', true, { initOnMounted: true, writeDefaults: false })
const command = 'npx skills add linkcraftstudio/feedlog-skills'
const { t } = useI18n()
const { copy, copied } = useClipboard({ source: command })
async function copyCommand() {
  await copy()
}
</script>

<template>
  <section class="dashboard-panel overflow-hidden">
    <div class="flex flex-col gap-3 dashboard-panel-header sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 class="flex items-center gap-2 font-heading text-sm font-bold"><Icon name="lucide:book-open" class="size-4 text-primary" />FeedLog Skills <span class="ml-1 font-sans text-xs font-normal text-muted-foreground">{{ t('mcp.optional') }}</span></h2>
        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">{{ t('mcp.skillsDescription') }}</p>
      </div>
      <Button variant="outline" size="sm" class="shrink-0 self-start sm:self-auto" :aria-expanded="open" aria-controls="mcp-skills-installation" @click="open = !open">{{ t(open ? 'mcp.hideInstructions' : 'mcp.installSkills') }}<Icon :name="open ? 'lucide:chevron-up' : 'lucide:chevron-down'" class="size-4" /></Button>
    </div>
    <div v-if="open" id="mcp-skills-installation" class="dashboard-panel-body space-y-4 border-t border-border">
      <p class="text-sm leading-relaxed text-muted-foreground">{{ t('mcp.skillsInstructions') }}</p>
      <div class="relative rounded-lg border border-border bg-muted p-4 pr-12">
        <pre class="whitespace-pre-wrap break-all text-xs leading-relaxed"><code>{{ command }}</code></pre>
        <Button variant="ghost" size="icon-sm" :aria-label="t('mcp.copyCommand')" class="absolute right-2 top-2" @click="copyCommand"><Icon :name="copied ? 'lucide:check' : 'lucide:copy'" class="size-4" /></Button>
      </div>
      <div><h3 class="text-xs font-semibold">{{ t('mcp.tryAsking') }}</h3><ul class="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">
        <li v-for="key in ['integrate', 'feedback', 'article']" :key="key" class="flex items-start gap-2"><Icon name="lucide:message-square" class="mt-0.5 size-3.5 shrink-0" /><span>{{ t('mcp.examples.' + key) }}</span></li>
      </ul></div>
    </div>
  </section>
</template>
