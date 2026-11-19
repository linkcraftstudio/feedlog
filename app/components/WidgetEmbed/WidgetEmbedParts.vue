<script setup lang="ts">
import { ref } from 'vue'
import WidgetEmbedImage from './WidgetEmbedImage.vue'
import type { Content } from '#layers/feedlog/shared/agent/content'
import { BookOpen, ChevronRight, ExternalLink, Globe2 } from 'lucide-vue-next'
defineProps<{ content: Content; plainText?: boolean }>()
const emit = defineEmits<{ feedback: [slug: string]; article: [slug: string] }>()
const faviconFailures = ref(new Set<string>())
const faviconUrl = (url: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=32`
</script>

<template>
  <div class="space-y-2">
    <template v-for="(part, index) in content.parts" :key="index">
      <p v-if="part.type === 'text' && plainText" class="whitespace-pre-wrap [overflow-wrap:anywhere]">{{ part.text }}</p>
      <WidgetEmbedMarkdown v-else-if="part.type === 'text'" :text="part.text" />
      <WidgetEmbedImage v-else-if="part.type === 'image'" :storage-key="part.storage_key" />
      <div v-else-if="part.type === 'article_reference'" class="space-y-1.5">
        <component :is="article.url ? 'a' : 'button'" v-for="article in part.articles" :key="article.article_id" :href="article.url" :target="article.url ? '_blank' : undefined" :rel="article.url ? 'noopener noreferrer' : undefined" :title="article.title" class="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-2.5 text-left text-[11.5px] font-semibold text-primary hover:border-primary/50" @click="!article.url && emit('article', article.slug)">
          <img v-if="article.url && !faviconFailures.has(faviconUrl(article.url))" :src="faviconUrl(article.url)" class="size-3.5 shrink-0 object-contain" alt="" aria-hidden="true" loading="eager" decoding="async" referrerpolicy="no-referrer" @error="faviconFailures.add(faviconUrl(article.url!))"><Globe2 v-else-if="article.url" class="size-3.5 shrink-0" /><BookOpen v-else class="size-3.5 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{{ article.title }}</span>
          <ExternalLink v-if="article.url" class="size-3 shrink-0" /><ChevronRight v-else class="size-3 shrink-0" />
        </component>
      </div>
      <WidgetEmbedFeedbackCard v-else-if="'feedback_id' in part" :feedback="part" @open="emit('feedback', $event)" />
    </template>
  </div>
</template>
