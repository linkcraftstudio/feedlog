<script setup lang="ts">
import { toast } from 'vue-sonner'

const { signIn, signUp, requestPasswordReset } = useAuth()
const { t } = useI18n()

const open = defineModel<boolean>('open', { default: false })

type ModalState = 'sign-in' | 'sign-in-email' | 'sign-up-email' | 'verify-email' | 'forgot-password' | 'reset-sent'
const state = ref<ModalState>('sign-in')

const loading = ref(false)

interface AuthMethods {
  google: boolean
  github: boolean
  email: boolean
  emailVerification: boolean
}
const { data: authCfg } = await useFetch<AuthMethods>('/api/auth-config', {
  key: 'auth-config',
  // If the endpoint hiccups, fall back to email-only so the modal still renders.
  default: () => ({ google: false, github: false, email: true, emailVerification: false }),
})
const hasOAuth = computed(() => !!(authCfg.value?.google || authCfg.value?.github))
const emailEnabled = computed(() => !!authCfg.value?.email)
const showSeparator = computed(() => hasOAuth.value && emailEnabled.value)

function initialState(): ModalState {
  // Skip the chooser when email is the only available method.
  return !hasOAuth.value && emailEnabled.value ? 'sign-in-email' : 'sign-in'
}

const form = reactive({
  name: '',
  email: '',
  password: '',
})

// Reset state when modal opens/closes
watch(open, (val) => {
  if (val) {
    state.value = initialState()
    resetForm()
  }
})

function resetForm() {
  form.name = ''
  form.email = ''
  form.password = ''
}

function switchTo(target: ModalState) {
  // If OAuth is the only reason the chooser exists, there's nothing to route back to.
  // Send the user straight to the email form instead.
  if (target === 'sign-in' && !hasOAuth.value && emailEnabled.value) {
    target = 'sign-in-email'
  }
  // Keep email when switching between related states
  const keepEmail = form.email
  if (['sign-in', 'sign-in-email', 'sign-up-email', 'forgot-password'].includes(target)) {
    form.email = keepEmail
  }
  form.password = ''
  form.name = ''
  state.value = target
}

// --- Social OAuth (shared popup logic) ---
//
// callbackURL is where better-auth 302s after the OAuth flow finishes
// (the redirect_uri registered with Google/GitHub).
//
//   - Default (authDomain unset or same-origin as the current page):
//     callbackURL='/auth/callback' — same-origin popup that postMessages
//     the opener and closes.
//
//   - Cross-domain (authDomain on a different host): callbackURL is
//     `{authDomain}/api/auth/post-login?return=...`, an endpoint that
//     mints a one-time-token and bounces back to the current host's
//     /api/auth/handoff. The handoff endpoint sets the session cookie and
//     lands the popup on /auth/callback, which then postMessages the
//     opener as before.
function buildCallbackURL(): string {
  const authDomain = (useRuntimeConfig().public.authDomain || '') as string
  if (!authDomain || typeof window === 'undefined') return '/auth/callback'
  let crossOrigin = false
  try {
    crossOrigin = new URL(authDomain).origin !== window.location.origin
  } catch {
    return '/auth/callback'
  }
  if (!crossOrigin) return '/auth/callback'
  const returnTo = `${window.location.origin}/auth/callback`
  return `${authDomain}/api/auth/post-login?return=${encodeURIComponent(returnTo)}`
}

async function loginWithSocial(provider: 'google' | 'github') {
  loading.value = true

  const res = await $fetch<{ url: string }>('/api/auth/sign-in/social', {
    method: 'POST',
    body: { provider, callbackURL: buildCallbackURL() },
  })

  const width = 500
  const height = 600
  const left = window.screenX + (window.outerWidth - width) / 2
  const top = window.screenY + (window.outerHeight - height) / 2

  const oauthUrl = new URL(res.url)
  if (provider === 'google') {
    oauthUrl.searchParams.set('prompt', 'select_account')
  }

  const popup = window.open(
    oauthUrl.toString(),
    `${provider}-login`,
    `width=${width},height=${height},left=${left},top=${top},popup=yes`,
  )

  const timer = setInterval(() => {
    if (popup?.closed) {
      clearInterval(timer)
      loading.value = false
    }
  }, 500)

  function onMessage(event: MessageEvent) {
    if (event.data?.type === 'auth-callback') {
      clearInterval(timer)
      window.removeEventListener('message', onMessage)
      loading.value = false
      open.value = false
      refreshNuxtData('auth-session')
    }
  }

  window.addEventListener('message', onMessage)
}

// --- Email Sign In ---
async function handleSignIn() {
  if (!form.email || !form.password) return
  loading.value = true
  try {
    const { error } = await signIn.email({
      email: form.email,
      password: form.password,
    })
    if (error) {
      if (error.code === 'EMAIL_NOT_VERIFIED') {
        toast.error(t('auth.errors.emailNotVerified'))
      } else if (error.code === 'INVALID_EMAIL_OR_PASSWORD') {
        toast.error(t('auth.errors.invalidCredentials'))
      } else {
        toast.error(error.message || t('auth.errors.signInFailed'))
      }
      return
    }
    open.value = false
    refreshNuxtData('auth-session')
  } finally {
    loading.value = false
  }
}

// --- Email Sign Up ---
async function handleSignUp() {
  if (!form.name || !form.email || !form.password) return
  if (form.password.length < 8) {
    toast.error(t('auth.errors.passwordTooShort'))
    return
  }
  loading.value = true
  try {
    const { error } = await signUp.email({
      name: form.name,
      email: form.email,
      password: form.password,
    })
    if (error) {
      toast.error(error.message || t('auth.errors.signUpFailed'))
      return
    }
    if (authCfg.value?.emailVerification) {
      state.value = 'verify-email'
    } else {
      open.value = false
      refreshNuxtData('auth-session')
    }
  } finally {
    loading.value = false
  }
}

// --- Email Verification Polling ---
let pollingTimer: ReturnType<typeof setInterval> | null = null

async function checkSession() {
  const { data } = await useFetch('/api/auth/get-session', { key: 'auth-session-poll' })
  if (data.value) {
    stopPolling()
    open.value = false
    refreshNuxtData('auth-session')
  }
}

function startPolling() {
  stopPolling()
  pollingTimer = setInterval(checkSession, 3000)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
  document.removeEventListener('visibilitychange', onVisibilityChange)
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    checkSession()
  }
}

watch(state, (val) => {
  if (val === 'verify-email') {
    startPolling()
  } else {
    stopPolling()
  }
})

onUnmounted(() => {
  stopPolling()
})

// "I've verified" button — try to sign in with the form credentials
async function handleVerified() {
  loading.value = true
  try {
    const { error } = await signIn.email({
      email: form.email,
      password: form.password,
    })
    if (error) {
      if (error.code === 'EMAIL_NOT_VERIFIED') {
        toast.error(t('auth.errors.notYetVerified'))
      } else {
        toast.error(error.message || t('auth.errors.signInFailed'))
      }
      return
    }
    stopPolling()
    open.value = false
    refreshNuxtData('auth-session')
  } finally {
    loading.value = false
  }
}

// Resend verification email
const resendCooldown = ref(0)
let resendTimer: ReturnType<typeof setInterval> | null = null

async function resendVerification() {
  if (resendCooldown.value > 0) return
  try {
    await $fetch('/api/auth/send-verification-email', {
      method: 'POST',
      body: { email: form.email },
    })
    toast.success(t('auth.success.verificationResent'))
    resendCooldown.value = 60
    resendTimer = setInterval(() => {
      resendCooldown.value--
      if (resendCooldown.value <= 0 && resendTimer) {
        clearInterval(resendTimer)
        resendTimer = null
      }
    }, 1000)
  } catch {
    toast.error(t('auth.errors.resendFailed'))
  }
}

// --- Forgot Password ---
async function handleForgotPassword() {
  if (!form.email) {
    toast.error(t('auth.errors.enterEmail'))
    return
  }
  loading.value = true
  try {
    await requestPasswordReset({
      email: form.email,
      redirectTo: '/reset-password',
    })
    state.value = 'reset-sent'
  } catch {
    toast.error(t('auth.errors.sendResetFailed'))
  } finally {
    loading.value = false
  }
}

// Password visibility toggle
const showPassword = ref(false)
</script>

<template>
  <Dialog v-if="open" :open="true" @update:open="open = $event">
    <DialogContent class="sm:max-w-sm">
      <!-- State 1: Sign In (OAuth first) -->
      <template v-if="state === 'sign-in'">
        <DialogHeader class="text-center space-y-2">
          <AppLogo :size="48" class="mx-auto" />
          <DialogTitle class="font-heading text-xl">{{ $t('auth.signIn.title') }}</DialogTitle>
          <DialogDescription>{{ $t('auth.signIn.subtitle') }}</DialogDescription>
        </DialogHeader>

        <div v-if="hasOAuth" class="space-y-2 pt-2">
          <Button
            v-if="authCfg?.google"
            class="w-full"
            variant="outline"
            size="lg"
            :disabled="loading"
            @click="loginWithSocial('google')"
          >
            <Icon name="logos:google-icon" class="mr-2 size-5" />
            {{ $t('auth.signIn.google') }}
          </Button>
          <Button
            v-if="authCfg?.github"
            class="w-full"
            variant="outline"
            size="lg"
            :disabled="loading"
            @click="loginWithSocial('github')"
          >
            <Icon name="mdi:github" class="mr-2 size-5" />
            {{ $t('auth.signIn.github') }}
          </Button>
        </div>

        <div v-if="showSeparator" class="relative my-2">
          <Separator />
          <span class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs text-muted-foreground">{{ $t('auth.signIn.or') }}</span>
        </div>

        <Button
          v-if="emailEnabled"
          class="w-full"
          variant="outline"
          size="lg"
          :disabled="loading"
          @click="switchTo('sign-in-email')"
        >
          <Icon name="lucide:mail" class="mr-2 size-5" />
          {{ $t('auth.signIn.withEmail') }}
        </Button>

        <p v-if="emailEnabled" class="text-center text-sm text-muted-foreground">
          {{ $t('auth.signIn.noAccount') }}
          <button class="text-primary hover:underline font-medium" @click="switchTo('sign-up-email')">{{ $t('common.signUp') }}</button>
        </p>
      </template>

      <!-- State 2: Sign In with Email -->
      <template v-if="state === 'sign-in-email'">
        <DialogHeader class="text-center space-y-2">
          <AppLogo :size="48" class="mx-auto" />
          <DialogTitle class="font-heading text-xl">{{ $t('auth.signInEmail.title') }}</DialogTitle>
        </DialogHeader>
        <form class="space-y-4 pt-2" @submit.prevent="handleSignIn">
          <div class="space-y-2">
            <label class="text-sm font-medium" for="signin-email">{{ $t('common.email') }}</label>
            <Input
              id="signin-email"
              v-model="form.email"
              type="email"
              :placeholder="$t('auth.emailPlaceholder')"
              required
            />
          </div>
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <label class="text-sm font-medium" for="signin-password">{{ $t('common.password') }}</label>
              <button
                type="button"
                class="text-xs text-muted-foreground hover:text-primary transition-colors"
                @click="switchTo('forgot-password')"
              >
                {{ $t('auth.forgot.title') }}
              </button>
            </div>
            <div class="relative">
              <Input
                id="signin-password"
                v-model="form.password"
                :type="showPassword ? 'text' : 'password'"
                :placeholder="$t('auth.signInEmail.passwordPlaceholder')"
                required
                class="pr-10"
              />
              <button
                type="button"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                @click="showPassword = !showPassword"
              >
                <Icon :name="showPassword ? 'lucide:eye-off' : 'lucide:eye'" size="16" />
              </button>
            </div>
          </div>
          <Button type="submit" class="w-full" size="lg" :disabled="loading">
            <Spinner v-if="loading" class="mr-2 size-4" />
            {{ $t('common.signIn') }}
          </Button>
        </form>

        <button
          v-if="hasOAuth"
          class="w-full text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center gap-1"
          @click="switchTo('sign-in')"
        >
          <Icon name="lucide:arrow-left" size="14" />
          {{ $t('auth.signIn.otherOptions') }}
        </button>

        <p class="text-center text-sm text-muted-foreground">
          {{ $t('auth.signIn.noAccount') }}
          <button class="text-primary hover:underline font-medium" @click="switchTo('sign-up-email')">{{ $t('common.signUp') }}</button>
        </p>
      </template>

      <!-- State 3: Sign Up with Email -->
      <template v-if="state === 'sign-up-email'">
        <DialogHeader class="text-center space-y-2">
          <AppLogo :size="48" class="mx-auto" />
          <DialogTitle class="font-heading text-xl">{{ $t('auth.signUp.title') }}</DialogTitle>
        </DialogHeader>
        <form class="space-y-4 pt-2" @submit.prevent="handleSignUp">
          <div class="space-y-2">
            <label class="text-sm font-medium" for="signup-name">{{ $t('common.name') }}</label>
            <Input
              id="signup-name"
              v-model="form.name"
              type="text"
              :placeholder="$t('auth.signUp.namePlaceholder')"
              required
            />
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium" for="signup-email">{{ $t('common.email') }}</label>
            <Input
              id="signup-email"
              v-model="form.email"
              type="email"
              :placeholder="$t('auth.emailPlaceholder')"
              required
            />
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium" for="signup-password">{{ $t('common.password') }}</label>
            <div class="relative">
              <Input
                id="signup-password"
                v-model="form.password"
                :type="showPassword ? 'text' : 'password'"
                :placeholder="$t('auth.passwordMinHint')"
                required
                minlength="8"
                class="pr-10"
              />
              <button
                type="button"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                @click="showPassword = !showPassword"
              >
                <Icon :name="showPassword ? 'lucide:eye-off' : 'lucide:eye'" size="16" />
              </button>
            </div>
          </div>
          <Button type="submit" class="w-full" size="lg" :disabled="loading">
            <Spinner v-if="loading" class="mr-2 size-4" />
            {{ $t('common.signUp') }}
          </Button>
        </form>

        <p class="text-center text-sm text-muted-foreground">
          {{ $t('auth.signUp.haveAccount') }}
          <button class="text-primary hover:underline font-medium" @click="switchTo('sign-in')">{{ $t('common.signIn') }}</button>
        </p>
      </template>

      <!-- State 5: Verify Email -->
      <template v-if="state === 'verify-email'">
        <DialogHeader class="text-center space-y-2">
          <div class="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Icon name="lucide:mail" size="24" class="text-primary" />
          </div>
          <DialogTitle class="font-heading text-xl">{{ $t('auth.checkEmail') }}</DialogTitle>
          <DialogDescription>
            {{ $t('auth.verifyEmail.sentTo') }}
            <span class="font-medium text-foreground">{{ form.email }}</span>
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-4 pt-2">
          <p class="text-sm text-center text-muted-foreground">
            {{ $t('auth.verifyEmail.instruction') }}
          </p>
          <Button class="w-full" size="lg" :disabled="loading" @click="handleVerified">
            <Spinner v-if="loading" class="mr-2 size-4" />
            {{ $t('auth.verifyEmail.verified') }}
          </Button>
          <p class="text-center text-sm text-muted-foreground">
            {{ $t('auth.verifyEmail.didntReceive') }}
            <button
              class="text-primary hover:underline font-medium"
              :class="{ 'opacity-50 cursor-not-allowed': resendCooldown > 0 }"
              :disabled="resendCooldown > 0"
              @click="resendVerification"
            >
              {{ $t('auth.verifyEmail.resend') }}{{ resendCooldown > 0 ? ` (${resendCooldown}s)` : '' }}
            </button>
          </p>
        </div>
      </template>

      <!-- State 6: Forgot Password -->
      <template v-if="state === 'forgot-password'">
        <DialogHeader class="text-center space-y-2">
          <div class="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Icon name="lucide:key-round" size="24" class="text-primary" />
          </div>
          <DialogTitle class="font-heading text-xl">{{ $t('auth.forgot.title') }}</DialogTitle>
          <DialogDescription>{{ $t('auth.forgot.subtitle') }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4 pt-2" @submit.prevent="handleForgotPassword">
          <div class="space-y-2">
            <label class="text-sm font-medium" for="forgot-email">{{ $t('common.email') }}</label>
            <Input
              id="forgot-email"
              v-model="form.email"
              type="email"
              :placeholder="$t('auth.emailPlaceholder')"
              required
            />
          </div>
          <Button type="submit" class="w-full" size="lg" :disabled="loading">
            <Spinner v-if="loading" class="mr-2 size-4" />
            {{ $t('auth.forgot.submit') }}
          </Button>
        </form>
        <p class="text-center text-sm text-muted-foreground">
          <button class="text-primary hover:underline font-medium" @click="switchTo('sign-in-email')">
            {{ $t('auth.backToSignIn') }}
          </button>
        </p>
      </template>

      <!-- State 7: Reset Email Sent -->
      <template v-if="state === 'reset-sent'">
        <DialogHeader class="text-center space-y-2">
          <div class="mx-auto w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
            <Icon name="lucide:mail-check" size="24" class="text-green-600 dark:text-green-400" />
          </div>
          <DialogTitle class="font-heading text-xl">{{ $t('auth.checkEmail') }}</DialogTitle>
          <DialogDescription>
            {{ $t('auth.resetSent.sentTo') }}
            <span class="font-medium text-foreground">{{ form.email }}</span>
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-4 pt-2">
          <p class="text-sm text-center text-muted-foreground">
            {{ $t('auth.resetSent.instruction') }}
          </p>
          <p class="text-center text-sm text-muted-foreground">
            <button class="text-primary hover:underline font-medium" @click="switchTo('sign-in')">
              ← Back to sign in
            </button>
          </p>
        </div>
      </template>
    </DialogContent>
  </Dialog>
</template>
