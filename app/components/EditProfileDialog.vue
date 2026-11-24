<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })
const saving = ref(false)
const dialogOpen = computed({
  get: () => open.value,
  set: (value: boolean) => { if (!saving.value) open.value = value },
})
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-sm" :show-close-button="!saving">
      <DialogHeader>
        <DialogTitle class="font-heading text-lg">
          {{ $t('auth.profile.title') }}
        </DialogTitle>
        <DialogDescription>
          {{ $t('auth.profile.subtitle') }}
        </DialogDescription>
      </DialogHeader>
      <AccountProfileForm v-if="open" v-model:saving="saving" @saved="open = false" @cancel="open = false" />
    </DialogContent>
  </Dialog>
</template>
