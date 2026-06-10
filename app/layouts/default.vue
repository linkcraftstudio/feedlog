<script setup lang="ts">
const { signOut } = useAuth()
const { data: session } = await useAuthSession()

const user = computed(() => session.value?.user)
// SSO sessions (signed in via the customer's product) are end-user only.
const isSsoSession = computed(
  () => !!(session.value as { session?: { ssoOrgId?: string | null } } | null)?.session?.ssoOrgId,
)
// Dashboard entry visibility matches the /dashboard middleware: any org
// member (owner / manager / contributor) gets in. Do NOT gate on
// `user.role === 'admin'` — that's the legacy better-auth admin plugin
// field, no longer consulted now that access is driven by org-membership
// role.
const orgCtx = useOrgContext()
// An SSO session is end-user only and can never reach the dashboard (server
// gates 403, /dashboard middleware redirects). Hide the entry too so we don't
// dangle a link that dead-ends — even if this email is an org member.
const canEnterDashboard = computed(() => !!user.value && !!orgCtx.value.role && !isSsoSession.value)

// User initials as avatar fallback
const initials = computed(() => {
  const name = user.value?.name || ''
  return name.slice(0, 2).toUpperCase()
})

// Fall back to initials when avatar image fails to load
const avatarError = ref(false)
watch(user, () => { avatarError.value = false })

const { isOpen: showLoginModal } = useLoginModal()
const showChangePassword = ref(false)

// SSO sessions can't manage credentials — the backend blocks set/change-password
// etc. Hide the control instead of offering an action that 403s.

const navItems = [
  { label: 'Feedback', to: '/', icon: 'lucide:message-square' },
  { label: 'Roadmap', to: '/roadmap', icon: 'lucide:map' },
  { label: 'Changelog', to: '/changelog', icon: 'lucide:newspaper' },
]

async function handleSignOut() {
  await signOut()
  session.value = null
  navigateTo('/')
}

// Mobile expandable nav
const mobileNavOpen = ref(false)
const route = useRoute()
watch(() => route.path, () => { mobileNavOpen.value = false })
</script>

<template>
  <div class="min-h-screen flex flex-col bg-background text-foreground font-body">
    <!-- Top navigation bar -->
    <header class="fixed top-0 left-0 right-0 z-50 border-b border-border bg-background/80 backdrop-blur-md w-full transition-colors duration-300">
      <!-- Main bar -->
      <div class="h-14 md:h-20 flex items-center justify-between px-4 md:px-6 lg:px-10">
        <!-- Left: Hamburger (mobile) + Logo + Navigation (desktop) -->
        <div class="flex items-center gap-3 md:gap-10">
          <!-- Mobile hamburger -->
          <button
            class="md:hidden w-9 h-9 flex items-center justify-center rounded-lg hover:bg-secondary transition-colors text-muted-foreground"
            @click="mobileNavOpen = !mobileNavOpen"
          >
            <Icon :name="mobileNavOpen ? 'lucide:x' : 'lucide:menu'" size="20" />
          </button>

          <AppBrand />

          <nav class="hidden md:flex items-center gap-8">
            <NuxtLink
              v-for="item in navItems"
              :key="item.to"
              :to="item.to"
              class="flex items-center text-sm font-bold tracking-wide text-muted-foreground hover:text-foreground transition-colors"
              active-class="!text-primary"
            >
              <Icon :name="item.icon" size="18" class="mr-2" />
              {{ item.label }}
            </NuxtLink>
          </nav>
        </div>

        <!-- Right side -->
        <div class="flex items-center gap-3 md:gap-4 lg:gap-6">
          <ThemeSwitcher />

          <!-- Dashboard link (admin only) -->
          <!-- Desktop: button with text -->
          <Button
            v-if="canEnterDashboard"
            as-child
            variant="secondary"
            class="hidden md:inline-flex"
          >
            <NuxtLink to="/dashboard">
              <Icon name="lucide:layout-dashboard" size="18" />
              Dashboard
            </NuxtLink>
          </Button>
          <!-- Mobile: icon only -->
          <NuxtLink
            v-if="canEnterDashboard"
            to="/dashboard"
            class="md:hidden w-9 h-9 flex items-center justify-center rounded-lg hover:bg-secondary transition-colors text-muted-foreground"
          >
            <Icon name="lucide:layout-dashboard" size="20" />
          </NuxtLink>

          <!-- Logged in: Avatar + Dropdown menu -->
          <DropdownMenu v-if="user">
            <DropdownMenuTrigger as-child>
              <button class="flex items-center rounded-full border border-border bg-card hover:border-primary transition-colors focus:outline-none p-1">
                <Avatar class="w-8 h-8">
                  <img v-if="user.image && !avatarError" :src="user.image" :alt="user.name" class="aspect-square size-full rounded-full object-cover" referrerpolicy="no-referrer" @error="avatarError = true">
                  <!-- Brand accent (not a neutral gray) so identity chips carry the
                       brand; derived in deriveBrandVars. -->
                  <AvatarFallback v-else class="bg-accent text-accent-foreground text-sm font-bold">
                    {{ initials }}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-48">
              <DropdownMenuLabel class="font-normal">
                <div class="flex flex-col space-y-1">
                  <p class="text-sm font-medium">{{ user.name }}</p>
                  <p class="text-xs text-muted-foreground truncate">{{ user.email }}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem v-if="!isSsoSession" @click="showChangePassword = true">
                <Icon name="lucide:key-round" size="16" class="mr-2" />
                Change Password
              </DropdownMenuItem>
              <DropdownMenuItem @click="handleSignOut">
                <Icon name="lucide:log-out" size="16" class="mr-2" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <!-- Not logged in: Sign in button -->
          <button
            v-if="!user"
            class="flex items-center gap-2 font-heading font-semibold text-sm px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all"
            @click="showLoginModal = true"
          >
            <Icon name="lucide:log-in" size="16" />
            <span class="hidden sm:inline">Sign in</span>
          </button>
        </div>
      </div>

      <!-- Mobile expandable nav row -->
      <div
        class="md:hidden overflow-hidden transition-all duration-200 ease-in-out"
        :style="{ maxHeight: mobileNavOpen ? '120px' : '0px' }"
      >
        <nav class="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 px-4 py-2.5 min-h-12 border-t border-border/50">
          <NuxtLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="flex items-center gap-1.5 text-sm font-bold text-muted-foreground hover:text-foreground transition-colors"
            active-class="!text-primary"
          >
            <Icon :name="item.icon" size="16" />
            {{ item.label }}
          </NuxtLink>
        </nav>
      </div>
    </header>

    <!-- Login modal (global, controlled via useLoginModal) -->
    <LoginModal v-model:open="showLoginModal" />
    <ChangePasswordDialog v-model:open="showChangePassword" />

    <!-- Page content (header is position:fixed, so add top padding equal to header height) -->
    <main class="flex-1 w-full max-w-[1200px] mx-auto flex flex-col md:flex-row gap-8 px-4 md:px-6 lg:px-10 pt-20 md:pt-28 pb-6 md:pb-8">
      <slot />
    </main>
  </div>
</template>
