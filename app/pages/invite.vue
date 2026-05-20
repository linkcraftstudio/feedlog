<script setup lang="ts">
import { authClient } from '~/lib/auth-client'

// Accept invitation page at /invite?id=<invitationId>.
//
// Renders four states:
//   - invalid: invitation missing / expired / canceled / accepted
//   - anonymous: not signed in; offer to sign in or register
//   - match: signed in with matching email; one-click accept
//   - mismatch: signed in with a different email; offer Switch account
//
// `layout: false` keeps the public-board chrome (nav + Sign-in button)
// off this page — this is a standalone auth-style shell with just a logo
// + brand row up top.

definePageMeta({ layout: false, middleware: [] })

const route = useRoute()
const router = useRouter()
// Reuse the project's global LoginModal — popping it in-page (vs navigating
// to /?login=1) keeps the user on /invite so the page can transition into
// 'match' / 'mismatch' state the moment the session refreshes.
const loginModal = useLoginModal()

const id = computed(() => {
  const raw = route.query.id
  return typeof raw === 'string' ? raw : null
})

interface InvitationView {
  id: string
  email: string
  status: string
  organizationName: string
  organizationSlug: string
  expiresAt: string | null
}

const { data: session } = useAuthSession()
const invitation = ref<InvitationView | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const accepting = ref(false)

// Public lookup endpoint (server/api/invitations/[id].get.ts). Don't use
// better-auth's organization.getInvitation — it requires the requester
// to already be signed in as the invited email, which collapses our
// anonymous/match/mismatch states into a single "Invitation unavailable"
// page and breaks the flow. Better-auth's acceptInvitation still does the
// email-binding check at the security-critical step.
onMounted(async () => {
  if (!id.value) {
    error.value = 'invalid'
    loading.value = false
    return
  }
  try {
    invitation.value = await $fetch<InvitationView>(`/api/invitations/${id.value}`)
  } catch {
    error.value = 'invalid'
  } finally {
    loading.value = false
  }
})

type State = 'loading' | 'invalid' | 'anonymous' | 'match' | 'mismatch'
const state = computed<State>(() => {
  if (loading.value) return 'loading'
  if (error.value || !invitation.value) return 'invalid'
  if (!session.value?.user) return 'anonymous'
  return session.value.user.email === invitation.value.email ? 'match' : 'mismatch'
})

async function accept() {
  if (!invitation.value) return
  accepting.value = true
  try {
    await authClient.organization.acceptInvitation({ invitationId: invitation.value.id })
    // customSession embeds orgList in the session cookie cache (maxAge:
    // 60s). The just-acquired membership isn't visible there yet, so the
    // /dashboard admin middleware would see an empty orgList and bounce
    // the user back to /. Force a no-cache read to push the fresh
    // orgList into the cookie cache before navigating.
    await $fetch('/api/auth/get-session', { query: { disableCookieCache: 'true' } })
    await refreshNuxtData('auth-session')
    // Keep `accepting` true through the navigation — there's a microtask
    // gap between `router.push` resolving and this component unmounting
    // where the button label would otherwise flicker back to "Join …".
    await router.push('/dashboard')
  } catch (e) {
    error.value = (e as Error)?.message ?? 'invalid'
    accepting.value = false
  }
}

function startSignIn() {
  // Just open the modal — LoginModal handles OAuth via popup (window.open
  // centered, postMessage on completion) so the current /invite URL stays
  // intact and the page state updates as soon as session refreshes.
  loginModal.open()
}

async function switchAccount() {
  await authClient.signOut()
  // Same as anonymous flow once signed out.
  loginModal.open()
}

const userInitials = computed(() => {
  const name = session.value?.user?.name ?? ''
  return name.slice(0, 2).toUpperCase()
})
</script>

<template>
  <div class="min-h-screen bg-background font-body flex items-center justify-center px-6 py-12">
    <!-- Global login modal — this page sets layout:false so the default
         layout's <LoginModal/> mount is absent; mount our own here. -->
    <LoginModal v-model:open="loginModal.isOpen.value" />
    <div class="w-full max-w-md text-center">
      <AppLogo :size="44" class="mx-auto mb-6" />

      <template v-if="state === 'loading'">
        <p class="text-sm text-muted-foreground">Loading…</p>
      </template>

      <template v-else-if="state === 'invalid'">
        <h1 class="font-heading text-2xl font-bold tracking-tight">Invitation unavailable</h1>
        <p class="text-sm text-muted-foreground mt-2 leading-relaxed">
          This invitation is no longer available.
        </p>
        <NuxtLink to="/" class="mt-8 inline-flex h-11 px-5 rounded-lg border border-border bg-card text-sm font-semibold hover:bg-secondary transition-colors items-center gap-2">
          Go to FeedLog
          <Icon name="lucide:arrow-right" size="14" />
        </NuxtLink>
      </template>

      <template v-else-if="state === 'anonymous'">
        <h1 class="font-heading text-2xl font-bold tracking-tight">Join FeedLog</h1>
        <p class="text-sm text-muted-foreground mt-2 leading-relaxed">
          Join <span class="font-semibold text-foreground">{{ invitation!.organizationName }}</span>'s team on FeedLog
        </p>

        <button
          class="mt-8 w-full h-11 rounded-lg bg-primary text-primary-foreground text-sm font-heading font-bold hover:opacity-90 transition-all flex items-center justify-center gap-2"
          @click="startSignIn"
        >
          Sign in to continue
          <Icon name="lucide:arrow-right" size="14" />
        </button>

        <p class="mt-3 text-[11px] text-muted-foreground">
          You'll sign in or create a FeedLog account along the way.
        </p>
      </template>

      <template v-else-if="state === 'match'">
        <h1 class="font-heading text-2xl font-bold tracking-tight">Join FeedLog</h1>
        <p class="text-sm text-muted-foreground mt-2 leading-relaxed">
          Join <span class="font-semibold text-foreground">{{ invitation!.organizationName }}</span>'s team on FeedLog
        </p>

        <div class="mt-6 flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-card text-left">
          <div class="w-10 h-10 rounded-full overflow-hidden bg-accent shrink-0 flex items-center justify-center">
            <img
              v-if="session!.user.image"
              :src="session!.user.image"
              :alt="session!.user.name"
              class="w-full h-full object-cover"
              referrerpolicy="no-referrer"
            >
            <span v-else class="text-accent-foreground text-sm font-bold">{{ userInitials }}</span>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-bold truncate leading-tight">{{ session!.user.name }}</p>
            <p class="text-xs text-muted-foreground truncate leading-tight mt-0.5">{{ session!.user.email }}</p>
          </div>
        </div>

        <button
          :disabled="accepting"
          class="mt-4 w-full h-11 rounded-lg bg-primary text-primary-foreground text-sm font-heading font-bold hover:opacity-90 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
          @click="accept"
        >
          {{ accepting ? 'Joining…' : `Join ${invitation!.organizationName}` }}
          <Icon name="lucide:arrow-right" size="14" />
        </button>

        <p class="mt-3 text-[11px] text-muted-foreground">
          Not you?
          <a class="text-foreground font-semibold hover:underline ml-1 cursor-pointer" @click="switchAccount">Sign out</a>
        </p>
      </template>

      <template v-else-if="state === 'mismatch'">
        <h1 class="font-heading text-2xl font-bold tracking-tight">Join FeedLog</h1>
        <p class="text-sm text-muted-foreground mt-2 leading-relaxed">
          Join <span class="font-semibold text-foreground">{{ invitation!.organizationName }}</span>'s team on FeedLog
        </p>

        <div class="mt-6 flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-card text-left">
          <div class="w-10 h-10 rounded-full overflow-hidden bg-accent shrink-0 flex items-center justify-center">
            <img
              v-if="session!.user.image"
              :src="session!.user.image"
              :alt="session!.user.name"
              class="w-full h-full object-cover"
              referrerpolicy="no-referrer"
            >
            <span v-else class="text-accent-foreground text-sm font-bold">{{ userInitials }}</span>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-bold truncate leading-tight">{{ session!.user.name }}</p>
            <p class="text-xs text-muted-foreground truncate leading-tight mt-0.5">{{ session!.user.email }}</p>
          </div>
        </div>

        <p class="mt-4 text-xs text-red-600 leading-relaxed flex items-center justify-center gap-1.5">
          <Icon name="lucide:alert-circle" size="13" class="shrink-0" />
          <span>
            This invitation was sent to <span class="font-semibold">{{ invitation!.email }}</span>.
            <a class="text-foreground font-semibold hover:underline ml-1 cursor-pointer" @click="switchAccount">Switch account</a>
          </span>
        </p>
      </template>
    </div>
  </div>
</template>
