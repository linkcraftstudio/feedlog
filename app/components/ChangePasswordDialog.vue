<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })
const hasPassword = ref<boolean | null>(null)
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle class="font-heading text-lg">
          {{ hasPassword ? $t('auth.changePassword.title') : $t('auth.changePassword.setTitle') }}
        </DialogTitle>
        <DialogDescription>
          {{ hasPassword ? $t('auth.changePassword.subtitle') : $t('auth.changePassword.setSubtitle') }}
        </DialogDescription>
      </DialogHeader>
      <AccountPasswordForm v-if="open" v-model:has-password="hasPassword" @saved="open = false" @cancel="open = false" />
    </DialogContent>
  </Dialog>
</template>
