<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import { useMcpClients } from '~/composables/useMcpClients'
const props = defineProps<{ serverUrl: string }>()
const serverUrl = toRef(props, 'serverUrl')
const clients = useMcpClients(serverUrl)
const selectedId = ref('claude')
const selected = computed(() => clients.value.find(client => client.id === selectedId.value)!)
const { t } = useI18n()
const { copy, copied, text } = useClipboard()
</script>

<template>
  <section class="dashboard-panel overflow-hidden">
    <div class="dashboard-panel-header border-b border-border">
      <h2 class="font-heading text-sm font-bold">{{ t('mcp.connectApplication') }}</h2>
      <p class="mt-1 text-xs leading-relaxed text-muted-foreground">{{ t('mcp.connectDescription') }}</p>
    </div>
    <div class="dashboard-panel-body space-y-5">
      <div class="grid grid-cols-3 gap-2 sm:grid-cols-6" role="group" :aria-label="t('mcp.chooseApplication')">
        <button v-for="client in clients" :key="client.id" type="button" class="flex min-w-0 flex-col items-center gap-2 rounded-lg border px-2 py-4 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-ring" :class="selectedId === client.id ? 'border-primary bg-secondary text-primary' : 'border-border text-muted-foreground hover:bg-muted'" :aria-pressed="selectedId === client.id" @click="selectedId = client.id"><McpLogo :type="client.id" /><span class="truncate">{{ client.name }}</span></button>
      </div>
      <p class="text-sm leading-relaxed text-muted-foreground">{{ selected.instructions }}</p>
      <div v-if="selected.command || selected.configuration" class="relative rounded-lg border border-border bg-muted p-4 pr-12">
        <pre class="whitespace-pre-wrap break-all text-xs leading-relaxed"><code>{{ selected.command || selected.configuration }}</code></pre>
        <Button variant="ghost" size="icon-sm" class="absolute top-2 right-2" :aria-label="t('mcp.copyCommand')" @click="copy(selected.command || selected.configuration || '')"><Icon :name="copied && text !== serverUrl ? 'lucide:check' : 'lucide:copy'" class="size-4" /></Button>
      </div>
      <Button v-if="selected.install" as-child variant="outline"><a :href="selected.install" target="_blank" rel="noopener noreferrer">{{ t('mcp.addTo', { client: selected.name }) }}<Icon name="lucide:arrow-up-right" class="size-4" /></a></Button>
      <div class="flex items-center gap-3 text-xs">
        <span class="shrink-0 text-muted-foreground">{{ t('mcp.serverUrl') }}</span><code class="min-w-0 flex-1 break-all">{{ serverUrl }}</code>
        <Button variant="ghost" size="icon-sm" :aria-label="t('mcp.copyServerUrl')" @click="copy(serverUrl)"><Icon :name="copied && text === serverUrl ? 'lucide:check' : 'lucide:copy'" class="size-4" /></Button>
      </div>
      <div v-if="selected.note || selected.docs" class="flex flex-wrap items-start justify-between gap-3 text-xs leading-relaxed">
        <p v-if="selected.note" class="min-w-0 flex-1 text-muted-foreground">{{ selected.note }}</p>
        <a v-if="selected.docs" :href="selected.docs" target="_blank" rel="noopener noreferrer" class="inline-flex shrink-0 items-center gap-1 text-primary hover:underline">{{ t('mcp.officialGuide') }}<Icon name="lucide:arrow-up-right" class="size-3.5" /></a>
      </div>
    </div>
  </section>
</template>
