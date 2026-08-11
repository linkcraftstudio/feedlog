<script setup lang="ts">
import type { WidgetConversationItem } from '~~/server/api/widget/conversations/index.get'

defineProps<{
  items: WidgetConversationItem[]
  orgInitial: string
  totalCount: number
  totalKnown: boolean
  unreadCount: number
}>()

const emit = defineEmits<{
  open: [id: string]
  openFeedback: []
  newConversation: []
}>()

const { t } = useI18n()

// 2h / 5d / 2w / 2mo, which useTimeAgo() cannot produce.
function compactAge(d: string | Date): string {
  const mins = Math.max(1, Math.floor((Date.now() - new Date(d).getTime()) / 60000))
  if (mins < 60) return t('widget.timeAgoMinute', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('widget.timeAgoHour', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return t('widget.timeAgoDay', { n: days })
  if (days < 30) return t('widget.timeAgoWeek', { n: Math.floor(days / 7) })
  return t('widget.timeAgoMonth', { n: Math.floor(days / 30) })
}

const TITLE_FALLBACK_CHARS = 20
function rowTitle(c: WidgetConversationItem): string {
  if (c.title) return c.title
  const chars = Array.from(c.firstUserText ?? '')
  return chars.length > TITLE_FALLBACK_CHARS ? `${chars.slice(0, TITLE_FALLBACK_CHARS).join('')}…` : chars.join('')
}
</script>

<template>
  <div class="relative flex-1 min-h-0 flex flex-col bg-card">
    <div class="flex-1 overflow-y-auto">
      <button
        class="w-full flex items-center gap-3.5 px-5 py-3.5 text-left border-b border-border hover:bg-secondary/55 transition-colors"
        @click="emit('openFeedback')"
      >
        <span class="w-8.5 h-8.5 shrink-0 inline-flex items-center justify-center text-primary">
          <Icon name="lucide:inbox" size="21" />
        </span>
        <span class="flex-1 min-w-0 text-base font-semibold leading-5.5">{{ t('widget.myFeedback') }}</span>
        <span
          v-if="unreadCount"
          class="shrink-0 inline-flex items-center h-5 px-2.25 rounded-full bg-primary text-primary-foreground text-[11px] font-bold whitespace-nowrap"
        >{{ t('widget.newBadge', { count: unreadCount }) }}</span>
        <span v-else-if="totalKnown" class="text-[15px] leading-5 text-muted-foreground tabular-nums">{{ totalCount }}</span>
        <span class="shrink-0 inline-flex text-muted-foreground">
          <Icon name="lucide:chevron-right" size="16" />
        </span>
      </button>

      <button
        v-for="c in items"
        :key="c.id"
        class="relative w-full grid grid-cols-[34px_minmax(0,1fr)_auto] gap-x-3.5 gap-y-0.5 px-5 py-3.5 text-left hover:bg-secondary/55 transition-colors after:content-[''] after:absolute after:inset-x-5 after:bottom-0 after:h-px after:bg-border"
        @click="emit('open', c.id)"
      >
        <span class="row-span-2 w-8.5 h-8.5 mt-px rounded-full grid place-items-center bg-primary text-primary-foreground text-sm font-bold">
          {{ orgInitial }}
        </span>
        <span class="min-w-0 flex items-center gap-1.5 text-base font-semibold leading-5.5">
          <span class="truncate">{{ rowTitle(c) }}</span>
          <span v-if="c.unread" class="size-2 shrink-0 rounded-full bg-red-500" />
        </span>
        <span class="self-start text-[15px] leading-5.5 text-muted-foreground whitespace-nowrap">
          {{ compactAge(c.lastMessageAt) }}
        </span>
        <span class="col-span-2 min-w-0 truncate text-[15px] leading-5.25 text-muted-foreground">
          {{ c.preview }}
        </span>
      </button>
    </div>

    <div
      class="absolute inset-x-0 bottom-0 flex justify-center pointer-events-none pt-10 pb-7.5"
      style="background: linear-gradient(to top, var(--card) 55%, transparent)"
    >
      <button
        class="pointer-events-auto inline-flex items-center gap-3 h-10.5 px-5.5 rounded-full bg-primary text-primary-foreground text-[15px] font-semibold hover:brightness-105 transition-all"
        style="box-shadow: 0 8px 28px -8px color-mix(in oklab, var(--primary) 65%, transparent)"
        @click="emit('newConversation')"
      >
        {{ t('widget.newConversation') }}
        <Icon name="lucide:send-horizontal" size="17" />
      </button>
    </div>
  </div>
</template>
