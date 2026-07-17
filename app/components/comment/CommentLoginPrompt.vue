<script setup lang="ts">
const loginModal = useLoginModal()
</script>

<template>
  <div class="flex flex-col items-center gap-3 py-8 px-4 rounded-xl border border-dashed border-border bg-muted/30">
    <Icon name="lucide:message-square" size="28" class="text-muted-foreground/60" />
    <p class="text-sm text-muted-foreground">{{ $t('auth.commentPrompt.text') }}</p>
    <Button size="sm" @click="loginModal.open()">
      <Icon name="lucide:log-in" size="16" />
      {{ $t('common.signIn') }}
    </Button>
  </div>
</template>
