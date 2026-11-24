<script setup lang="ts">
import { toast } from 'vue-sonner'

const { changePassword, listAccounts } = useAuth()
const { t } = useI18n()

const props = defineProps<{ card?: boolean }>()
const emit = defineEmits<{ saved: []; cancel: [] }>()
const loading = ref(false)
const hasPassword = defineModel<boolean | null>('hasPassword', { default: null })

const form = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
})

const showCurrentPassword = ref(false)
const showNewPassword = ref(false)
const showConfirmPassword = ref(false)

onMounted(async () => {
  hasPassword.value = null
  try {
    const { data } = await listAccounts()
    hasPassword.value = data?.some((account: { providerId: string }) => account.providerId === 'credential') ?? false
  }
  catch {
    hasPassword.value = false
  }
})

function resetForm() {
  form.currentPassword = ''
  form.newPassword = ''
  form.confirmPassword = ''
  showCurrentPassword.value = false
  showNewPassword.value = false
  showConfirmPassword.value = false
}

function cancel() {
  resetForm()
  emit('cancel')
}

async function onSubmit() {
  if (loading.value || hasPassword.value === null) return
  if (form.newPassword !== form.confirmPassword) {
    toast.error(t('auth.errors.passwordsMismatch'))
    return
  }
  if (form.newPassword.length < 8) {
    toast.error(t('auth.errors.passwordTooShort'))
    return
  }

  loading.value = true
  try {
    if (hasPassword.value) {
      // Change password: requires current password
      const { error } = await changePassword({
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
        revokeOtherSessions: true,
      })
      if (error) {
        toast.error(error.message || t('auth.errors.changeFailed'))
        return
      }
    } else {
      // Set password: OAuth user, no current password
      try {
        await $fetch('/api/auth/set-password', {
          method: 'POST',
          body: { newPassword: form.newPassword },
        })
      } catch (error) {
        toast.error((error as { data?: { message?: string } }).data?.message || t('auth.errors.setFailed'))
        return
      }
    }
    toast.success(hasPassword.value ? t('auth.success.passwordUpdated') : t('auth.success.passwordSet'))
    hasPassword.value = true
    resetForm()
    emit('saved')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div v-if="hasPassword === null" class="flex items-center justify-center py-8">
    <Spinner class="size-6" />
  </div>

  <form v-else :class="props.card ? undefined : 'space-y-4'" @submit.prevent="onSubmit">
    <div :class="['space-y-4', props.card && 'dashboard-panel-body']">
      <!-- Current password (only for users who already have one) -->
      <div v-if="hasPassword" class="space-y-2">
        <label class="text-sm font-medium" for="current-password">{{ $t('auth.fields.current') }}</label>
        <div class="relative">
          <Input
            id="current-password"
            v-model="form.currentPassword"
            autocomplete="current-password"
            :type="showCurrentPassword ? 'text' : 'password'"
            required
            class="pr-10"
          />
          <button
            type="button"
            class="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            @click="showCurrentPassword = !showCurrentPassword"
          >
            <Icon :name="showCurrentPassword ? 'lucide:eye-off' : 'lucide:eye'" size="16" />
          </button>
        </div>
      </div>

      <div class="space-y-2">
        <label class="text-sm font-medium" for="new-password">{{ $t('auth.fields.new') }}</label>
        <div class="relative">
          <Input
            id="new-password"
            v-model="form.newPassword"
            autocomplete="new-password"
            :type="showNewPassword ? 'text' : 'password'"
            :placeholder="$t('auth.passwordMinHint')"
            required
            minlength="8"
            class="pr-10"
          />
          <button
            type="button"
            class="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            @click="showNewPassword = !showNewPassword"
          >
            <Icon :name="showNewPassword ? 'lucide:eye-off' : 'lucide:eye'" size="16" />
          </button>
        </div>
      </div>

      <div class="space-y-2">
        <label class="text-sm font-medium" for="confirm-password">{{ $t('auth.fields.confirm') }}</label>
        <div class="relative">
          <Input
            id="confirm-password"
            v-model="form.confirmPassword"
            autocomplete="new-password"
            :type="showConfirmPassword ? 'text' : 'password'"
            required
            minlength="8"
            class="pr-10"
          />
          <button
            type="button"
            class="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            @click="showConfirmPassword = !showConfirmPassword"
          >
            <Icon :name="showConfirmPassword ? 'lucide:eye-off' : 'lucide:eye'" size="16" />
          </button>
        </div>
      </div>

    </div>

    <div :class="props.card ? 'dashboard-panel-footer border-t border-border bg-muted/30 flex flex-wrap items-center justify-end gap-3' : 'space-y-4'">
      <Button v-if="props.card" type="button" variant="outline" :disabled="loading" @click="cancel">
        {{ $t('common.cancel') }}
      </Button>
      <Button type="submit" :class="!props.card && 'w-full'" :size="props.card ? 'default' : 'lg'" :disabled="loading">
        <Spinner v-if="loading" class="mr-2 size-4" />
        {{ hasPassword ? $t('auth.changePassword.submit') : $t('auth.changePassword.setTitle') }}
      </Button>
      <p v-if="!props.card" class="text-center">
        <button type="button" class="text-sm text-muted-foreground hover:text-foreground transition-colors" @click="cancel">
          {{ $t('common.cancel') }}
        </button>
      </p>
    </div>
  </form>
</template>
