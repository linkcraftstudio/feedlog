<script setup lang="ts">
defineProps<{ actorName?: string; actorImage?: string | null }>()
const emit = defineEmits<{ send: [note: string]; dismiss: [] }>()

const composing = ref(false)
const note = ref('')

function send(custom: boolean) {
  emit('send', custom ? note.value.trim() : '')
  composing.value = false
}
</script>

<template>
  <div class="relative rounded-xl border border-border bg-card p-4 shadow-lg">
    <button
      class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
      :aria-label="$t('post.statusNotify.dismiss')"
      @click="emit('dismiss')"
    >
      <Icon name="lucide:x" size="15" />
    </button>

    <p class="pr-7 text-[13px] font-bold leading-tight">{{ $t('post.statusNotify.title') }}</p>
    <p class="mt-1 text-[12px] leading-snug text-muted-foreground">{{ $t('post.statusNotify.desc') }}</p>

    <!-- Stacked: side by side these overflow the sidebar and wrap mid-label. -->
    <div class="mt-3 flex flex-col gap-2">
      <button
        class="w-full whitespace-nowrap rounded-lg bg-primary px-3 py-2 text-[12px] font-bold text-primary-foreground transition-all hover:bg-primary/90 active:scale-[0.98]"
        @click="send(false)"
      >
        {{ $t('post.statusNotify.send') }}
      </button>
      <button
        class="w-full whitespace-nowrap rounded-lg border border-border px-3 py-2 text-[12px] font-bold transition-colors hover:bg-secondary/50"
        @click="composing = true"
      >
        {{ $t('post.statusNotify.customize') }}
      </button>
    </div>

    <Dialog v-model:open="composing">
      <DialogContent
        :show-close-button="false"
        class="!max-w-[560px] border border-border bg-card !rounded-[20px] !p-6 shadow-warm"
      >
        <DialogTitle class="sr-only">{{ $t('post.statusNotify.customize') }}</DialogTitle>
        <DialogDescription class="sr-only">{{ $t('post.statusNotify.desc') }}</DialogDescription>

        <div class="flex items-center gap-2.5">
          <Avatar class="h-8 w-8">
            <AvatarImage v-if="actorImage" :src="actorImage" :alt="actorName ?? ''" />
            <AvatarFallback class="text-[12px] font-bold">{{ (actorName ?? '?').charAt(0).toUpperCase() }}</AvatarFallback>
          </Avatar>
          <span class="text-[15px] font-bold">{{ actorName }}</span>
        </div>

        <textarea
          v-model="note"
          rows="4"
          maxlength="2000"
          autofocus
          class="w-full resize-none rounded-xl border border-border bg-background/50 px-4 py-3 text-[14px] focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/10"
          :placeholder="$t('post.statusNotify.messagePlaceholder')"
        />

        <div class="flex items-center justify-end gap-3">
          <button
            class="whitespace-nowrap rounded-xl border border-border px-4 py-2.5 text-[13px] font-bold transition-colors hover:bg-secondary/50"
            @click="send(false)"
          >
            {{ $t('post.statusNotify.sendDefault') }}
          </button>
          <button
            class="whitespace-nowrap rounded-xl bg-primary px-4 py-2.5 text-[13px] font-bold text-primary-foreground transition-all hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
            :disabled="!note.trim()"
            @click="send(true)"
          >
            {{ $t('post.statusNotify.sendCustom') }}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
