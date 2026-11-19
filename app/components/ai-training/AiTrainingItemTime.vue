<script setup lang="ts">
const props = defineProps<{ value?: string | null; kind: 'sync' | 'published' }>()
const { t, locale } = useI18n()
const date = computed(() => props.value ? new Date(props.value) : null)
const label = computed(() => t(props.kind === 'sync' ? 'aiTraining.list.lastSync' : 'aiTraining.list.publishedAt'))
const formatted = computed(() => date.value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date.value) : '—')
const description = computed(() => date.value ? `${label.value}: ${new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai', hour12: false,
}).format(date.value)}` : t(props.kind === 'sync' ? 'aiTraining.noSuccessfulUpdate' : 'aiTraining.manage.unpublished'))
</script>
<template>
  <span class="inline-block w-24 shrink-0 whitespace-nowrap text-right text-xs font-medium leading-4 text-muted-foreground" :title="description" :aria-label="description" :data-ai-training-time="kind"><time v-if="value" :datetime="value">{{ formatted }}</time><template v-else>—</template></span>
</template>
