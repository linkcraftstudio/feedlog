<script setup lang="ts">

interface FeedbackItem {
  id: string
  title: string
  voteCount: number
  status: string
}

const props = defineProps<{
  initialSelectedIds: string[]
}>()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  confirm: [items: { id: string; title: string }[]]
}>()

const searchQuery = ref('')
const localSelectedIds = ref<string[]>([])
const sources = ref<FeedbackItem[]>([])
const loading = ref(false)

watch(open, async (isOpen) => {
  if (isOpen) {
    localSelectedIds.value = [...props.initialSelectedIds]
    searchQuery.value = ''
    await fetchFeedback()
  }
})

let searchTimer: ReturnType<typeof setTimeout>
watch(searchQuery, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => fetchFeedback(), 300)
})

async function fetchFeedback() {
  loading.value = true
  try {
    const query = searchQuery.value.trim()
    if (query) {
      const data = await useApiFetch<{ data: FeedbackItem[] }>('/api/posts/similar', {
        method: 'POST',
        body: { title: query, limit: 10 },
      })
      sources.value = data.data
    } else {
      const data = await useApiFetch<{ data: FeedbackItem[] }>('/api/admin/posts', {
        query: { pageSize: 20 },
      })
      sources.value = data.data
    }
  } catch {
    sources.value = []
  } finally {
    loading.value = false
  }
}

const MAX_SELECTION = 10
const isAtLimit = computed(() => localSelectedIds.value.length >= MAX_SELECTION)

function toggleSelection(id: string) {
  const idx = localSelectedIds.value.indexOf(id)
  if (idx >= 0) {
    localSelectedIds.value.splice(idx, 1)
  } else if (!isAtLimit.value) {
    localSelectedIds.value.push(id)
  }
}

function handleConfirm() {
  const items = localSelectedIds.value
    .map(id => {
      const src = sources.value.find(s => s.id === id)
      return src ? { id: src.id, title: src.title } : null
    })
    .filter(Boolean) as { id: string; title: string }[]
  emit('confirm', items)
}

function statusConfig(status: string) {
  const normalized = status.toLowerCase().replace(' ', '_')
  return STATUS_CONFIG[normalized as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      :show-close-button="false"
      class="!max-w-[800px] !max-h-[calc(100vh-4rem)] !p-0 !gap-0 flex flex-col overflow-hidden border border-border bg-card !rounded-[24px] shadow-warm"
    >
      <!-- Header -->
      <div class="px-8 pt-8 pb-6 shrink-0">
        <div class="flex items-start justify-between mb-1">
          <div class="flex flex-col gap-1">
            <DialogTitle class="text-[26px] font-bold font-heading leading-tight tracking-tight">{{ $t('changelog.picker.title') }}</DialogTitle>
            <p class="text-[14px] text-muted-foreground">{{ $t('changelog.picker.subtitle') }}</p>
          </div>
          <DialogClose class="text-muted-foreground hover:text-foreground transition-colors p-2 -mr-2 -mt-1">
            <Icon name="lucide:x" size="24" />
          </DialogClose>
        </div>
      </div>

      <!-- Search -->
      <div class="px-8 flex flex-col gap-4 mb-6 shrink-0">
        <div class="relative group">
          <Icon name="lucide:search" size="20" class="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/60 group-focus-within:text-primary transition-colors" />
          <Input
            v-model="searchQuery"
            class="pl-12 pr-12 py-3 h-auto bg-background/50 border-border rounded-xl text-[15px] focus-visible:ring-2 focus-visible:ring-primary/10 focus-visible:border-primary"
            :placeholder="$t('changelog.picker.searchPlaceholder')"
          />
        </div>
      </div>

      <!-- Results -->
      <div class="flex-1 overflow-y-auto px-6 min-h-0">
        <div v-if="loading" class="flex items-center justify-center py-12">
          <div class="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
        <div v-else-if="sources.length === 0" class="flex flex-col items-center py-12 text-sm text-muted-foreground">
          {{ $t('changelog.picker.noResults') }}
        </div>
        <div v-else class="flex flex-col pb-4">
          <div
            v-for="source in sources"
            :key="source.id"
            class="group relative flex items-start gap-4 p-4 rounded-xl transition-all cursor-pointer mb-1 border border-transparent"
            :class="[
              localSelectedIds.includes(source.id) ? 'bg-primary/5 !border-primary/10' : 'hover:bg-background',
              isAtLimit && !localSelectedIds.includes(source.id) ? 'opacity-40 cursor-not-allowed' : '',
            ]"
            @click="toggleSelection(source.id)"
          >
            <!-- Checkbox circle -->
            <div class="mt-1 flex-shrink-0">
              <div
                class="w-5 h-5 rounded-[6px] transition-all flex items-center justify-center"
                :class="localSelectedIds.includes(source.id)
                  ? 'bg-primary border-primary shadow-sm text-primary-foreground'
                  : 'border-2 border-border bg-card group-hover:border-primary/30 text-transparent'"
              >
                <Icon name="lucide:check" size="14" class="stroke-[3]" />
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-3 overflow-hidden">
                  <h4
                    class="text-[15px] font-bold font-heading truncate transition-colors"
                    :class="localSelectedIds.includes(source.id) ? 'text-primary' : 'group-hover:text-primary'"
                  >
                    {{ source.title }}
                  </h4>
                  <div class="flex items-center gap-3 text-muted-foreground/50 text-[12px] font-bold shrink-0">
                    <span class="flex items-center gap-0.5">
                      <Icon name="lucide:chevron-up" size="16" /> {{ source.voteCount }}
                    </span>
                  </div>
                </div>
              </div>
              <div class="flex items-center justify-between gap-4 mt-1">
                <p class="text-[13px] text-muted-foreground line-clamp-1 flex-1" />
                <span
                  class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider shrink-0 border"
                  :style="{
                    color: `var(${statusConfig(source.status).cssVar})`,
                    backgroundColor: `var(${statusConfig(source.status).cssVar}-bg)`,
                    borderColor: `var(${statusConfig(source.status).cssVar}-border)`,
                  }"
                >
                  <span class="w-1.5 h-1.5 rounded-full" :style="{ backgroundColor: `var(${statusConfig(source.status).cssVar})` }" />
                  {{ $t(statusLabelKey(source.status)) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-8 py-6 border-t border-border bg-card/50 shrink-0">
        <div class="flex items-center justify-between">
          <span class="text-[14px] font-medium" :class="isAtLimit ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground'">
            <strong class="text-foreground">{{ localSelectedIds.length }}</strong> / {{ MAX_SELECTION }} {{ $t('changelog.picker.selectedSuffix') }}
            <span v-if="isAtLimit" class="ml-1 text-xs">{{ $t('changelog.picker.limitReached') }}</span>
          </span>
          <div class="flex items-center gap-3">
            <button
              class="px-8 py-2.5 text-[14px] font-bold text-muted-foreground border border-border hover:bg-background transition-all rounded-xl"
              @click="open = false"
            >
              {{ $t('common.cancel') }}
            </button>
            <button
              class="px-8 py-2.5 text-[14px] font-bold bg-primary text-primary-foreground hover:bg-primary/90 transition-all rounded-xl shadow-sm"
              @click="handleConfirm"
            >
              {{ $t('changelog.picker.confirm') }}
            </button>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
