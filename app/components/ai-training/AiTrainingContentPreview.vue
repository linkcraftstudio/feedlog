<script setup lang="ts">
import type { AiTrainingItem } from '#layers/feedlog/shared/types/ai-training'
import { aiTrainingProcessingStatus } from '#layers/feedlog/shared/utils/ai-training'
import { Button } from '~/components/ui/button'
import ThemedMdPreview from '~/components/ThemedMdPreview.vue'
import AiTrainingStatusBadge from './AiTrainingStateBadge.vue'
defineProps<{ item: AiTrainingItem; content: string; loading: boolean; error: string; canManage: boolean }>()
const emit = defineEmits<{ back: []; retry: [] }>()
const localePath = useLocalePath()
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-ai-training-preview>
    <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border py-3 pl-4 pr-12 sm:pl-6 sm:pr-14">
      <Button variant="ghost" size="sm" class="-ml-2 text-xs" @click="emit('back')"><Icon name="lucide:arrow-left" size="14" />{{ $t('aiTraining.manage.backToList') }}</Button>
      <Button v-if="item.sourceId !== 'help' || canManage" variant="outline" size="sm" class="text-xs" as-child><a :href="item.sourceId === 'help' ? localePath('/dashboard/help/' + item.id) : item.url" target="_blank" rel="noopener noreferrer" data-ai-training-preview-link><Icon :name="item.sourceId === 'help' ? 'lucide:pencil' : 'lucide:external-link'" size="14" />{{ $t(item.sourceId === 'help' ? 'aiTraining.manage.editArticle' : 'aiTraining.manage.openOriginal') }}</a></Button>
    </div>
    <div class="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      <div class="mb-2 flex flex-wrap items-center gap-2"><h3 class="text-lg font-bold">{{ item.title }}</h3><HelpStatusBadge v-if="item.publicationStatus" :status="item.publicationStatus" /><AiTrainingStatusBadge v-else :status="aiTrainingProcessingStatus(item)" /></div>
      <p v-if="item.error" class="mt-4 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{{ item.error }}<span v-if="item.status === 'ready'" class="mt-1 block">{{ $t('aiTraining.list.previousVersionAvailable') }}</span></p>
      <p v-if="loading" role="status" class="py-10 text-sm text-muted-foreground">{{ $t('aiTraining.loading') }}</p>
      <div v-else-if="error" role="alert" class="py-8 text-sm text-destructive">{{ error }}<Button class="ml-3" variant="outline" size="sm" @click="emit('retry')">{{ $t('aiTraining.retry') }}</Button></div>
      <ThemedMdPreview v-else-if="item.status === 'ready'" :model-value="content" class="mt-6" />
      <p v-else class="py-10 text-sm text-muted-foreground">{{ item.status === 'indexing' ? $t('aiTraining.ui.previewContentAndUseItFor') : $t('aiTraining.ui.thisPageIsNotAvailableTo') }}</p>
    </div>
  </div>
</template>
