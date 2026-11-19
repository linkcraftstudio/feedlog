<script setup lang="ts">
import { Button } from '~/components/ui/button'
defineProps<{ kind: 'help' | 'website'; label: string; busy: boolean; syncBlocked?: boolean; canEnable?: boolean }>()
const emit = defineEmits<{ clear: []; visibility: [enabled: boolean]; sync: []; remove: [] }>()
</script>
<template>
  <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/30 px-4 py-3 sm:px-5" data-ai-training-bulk :data-ai-training-bulk-scope="kind">
    <div class="flex h-9 items-center gap-3"><span class="text-[13px] font-bold leading-[18px]">{{ label }}</span><button type="button" class="text-xs font-bold text-muted-foreground hover:text-foreground" :disabled="busy" @click="emit('clear')">{{ $t('help.admin.clear') }}</button></div>
    <div class="flex flex-wrap items-center gap-2">
      <Button v-if="kind === 'website'" variant="outline" size="sm" :disabled="busy || syncBlocked" @click="emit('sync')"><Icon name="lucide:refresh-cw" size="14" />{{ $t('aiTraining.manage.syncSelected') }}</Button>
      <DropdownMenu v-if="kind === 'help'"><DropdownMenuTrigger as-child><button type="button" class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-bold hover:bg-secondary disabled:opacity-50" :disabled="busy" data-ai-training-bulk-visibility>{{ $t('help.admin.aiVisibility') }}<Icon name="lucide:chevron-down" size="13" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem @select="emit('visibility', true)">{{ $t('help.admin.aiEnable') }}</DropdownMenuItem><DropdownMenuItem @select="emit('visibility', false)">{{ $t('help.admin.aiDisable') }}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <Button v-if="kind === 'website'" variant="outline" size="sm" class="text-destructive" :disabled="busy || syncBlocked" @click="emit('remove')">{{ $t('aiTraining.manage.deletePage') }}</Button>
    </div>
  </div>
</template>
