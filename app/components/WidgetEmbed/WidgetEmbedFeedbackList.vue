<script setup lang="ts">
import type { WidgetFeedbackItem } from '~~/server/api/widget/feedback/index.get'

const props = defineProps<{
  items: WidgetFeedbackItem[]
  loading: boolean
  hasMore: boolean
}>()

const emit = defineEmits<{
  loadMore: []
  open: [item: WidgetFeedbackItem]
}>()

const { t } = useI18n()
const timeAgo = useTimeAgo()
const formatDate = useFormatDate()

function postedAt(d: string | Date): string {
  return Date.now() - new Date(d).getTime() < 86400000 ? timeAgo(d) : formatDate(d)
}

// Infinite scroll. The observer is rebuilt whenever the sentinel remounts: this
// view is torn down every time the visitor goes back to the chat.
const bodyEl = ref<HTMLElement | null>(null)
const listSentinel = ref<HTMLElement | null>(null)
let listObserver: IntersectionObserver | null = null

watch(listSentinel, (el) => {
  listObserver?.disconnect()
  listObserver = null
  if (!el) return
  listObserver = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting) && props.hasMore && !props.loading) {
      emit('loadMore')
    }
  }, { root: bodyEl.value ?? null, rootMargin: '120px' })
  listObserver.observe(el)
}, { flush: 'post' })

onUnmounted(() => listObserver?.disconnect())
</script>

<template>
  <div ref="bodyEl" class="flex-1 overflow-y-auto bg-background">
    <p v-if="!items.length && !loading" class="px-5 py-8 text-xs text-muted-foreground text-center">
      {{ t('widget.noFeedback') }}
    </p>
    <ul v-else class="p-3 space-y-2">
      <li v-for="item in items" :key="item.id">
        <button
          class="w-full text-left px-3 py-2.5 rounded-md border border-border bg-card hover:border-primary/40 transition-colors group"
          @click="emit('open', item)"
        >
          <div class="flex items-start gap-2">
            <p class="flex-1 text-[13px] font-semibold leading-snug">
              {{ item.title }}
              <span v-if="item.unread" class="inline-block align-middle ml-1.5 w-1.75 h-1.75 rounded-full bg-primary" />
            </p>
            <WidgetEmbedStatusBadge :status="item.status" class="shrink-0" />
          </div>
          <div class="mt-0.5 text-xs text-muted-foreground flex items-center gap-0.5">
            <Icon name="lucide:chevron-up" size="12" />{{ item.voteCount }}
            <span class="mx-1">·</span>{{ postedAt(item.createdAt) }}
          </div>
          <div class="mt-1.5 flex justify-end">
            <span class="text-[11.5px] font-semibold text-primary flex items-center gap-0.5">
              {{ t('widget.viewOnBoard') }}<Icon name="lucide:arrow-up-right" size="11" />
            </span>
          </div>
        </button>
      </li>
      <li
        v-if="hasMore"
        ref="listSentinel"
        class="py-3 grid place-items-center"
        :aria-label="t('widget.loading')"
      >
        <Icon v-if="loading" name="lucide:loader-2" size="14" class="animate-spin text-muted-foreground" />
      </li>
    </ul>
  </div>
</template>
