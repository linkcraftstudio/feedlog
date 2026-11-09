<script setup lang="ts">
import { resolveAttachmentUrl } from '~/utils/attachment'

const { signOut } = useAuth()
const { data: session } = await useAuthSession()
const localePath = useLocalePath()

const user = computed(() => session.value?.user)

const initials = computed(() => {
  const name = user.value?.name || ''
  return name.slice(0, 2).toUpperCase()
})

const avatarError = ref(false)
const avatarUrl = computed(() => resolveAttachmentUrl(user.value?.image))
watch(user, () => { avatarError.value = false })

const showChangePassword = ref(false)
const showEditProfile = ref(false)
const { isOpen: showLoginModal, open: openLoginModal } = useLoginModal()

// An SSO session belongs in the dashboard but may not touch the global user
// record. Keep the entry visible; hiding it reads as a broken page.
const isSsoSession = computed(
  () => !!(session.value as { session?: { ssoOrgId?: string | null } } | null)?.session?.ssoOrgId,
)
function onChangePassword() {
  if (isSsoSession.value) {
    openLoginModal(LOCAL_AUTH_REASON)
    return
  }
  showChangePassword.value = true
}
function onEditProfile() {
  if (isSsoSession.value) {
    openLoginModal(LOCAL_AUTH_REASON)
    return
  }
  showEditProfile.value = true
}

async function handleSignOut() {
  await signOut()
  session.value = null
  navigateTo(localePath('/'))
}

const { mainNav, settingsNav, developerNav } = useDashboardNav()
const { canVisit, guardNavigation } = useDashboardAccess()

// Mobile menu
const mobileMenuOpen = ref(false)
const route = useRoute()
watch(() => route.path, () => { mobileMenuOpen.value = false })

const { t } = useI18n()
const config = useRuntimeConfig()
const settingsTitle = computed(() => t(config.public.rootDomain ? 'dashboard.nav.organizationSettings' : 'dashboard.nav.settings'))
const isPersonalSettings = computed(() => route.path === localePath('/dashboard/settings/personal'))
const navTitle = computed(() => {
  if (isPersonalSettings.value) return t('settings.personal.title')
  const match = [...mainNav.value, ...settingsNav.value, ...developerNav.value]
    .filter((item) => {
      const to = localePath(item.to)
      return route.path === to || route.path.startsWith(`${to}/`)
    })
    .sort((a, b) => b.to.length - a.to.length)[0]
  return match?.label ?? t('nav.dashboard')
})
useHead({ title: () => navTitle.value })

// Developer section: collapsed by default, but auto-expanded when the current
// route lives inside it (so the active page stays visible).
const { count: inboxCount, refresh: refreshInboxCount } = useInboxBadge()
const { canAccessInbox } = usePermission(computed(() => undefined), 'post')
let inboxTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  if (canAccessInbox.value) void refreshInboxCount()
  inboxTimer = setInterval(() => { if (!document.hidden && canAccessInbox.value) void refreshInboxCount() }, 10000)
})
onBeforeUnmount(() => clearInterval(inboxTimer))
const developerOpen = ref(developerNav.value.some(item => route.path.startsWith(item.to)))

const onboarding = useOnboarding()
// Resolved by the dashboard middleware before any dashboard page renders, so the
// guide opens as soon as the page hydrates.
const onboardingStatus = useState<{ autoOpen: boolean } | null>('onboarding-status')
onMounted(() => onboarding.load(onboardingStatus.value?.autoOpen === true))
</script>

<template>
  <div class="h-screen overflow-hidden flex flex-col md:flex-row bg-background text-foreground font-body">
    <!-- Mobile header -->
    <header class="md:hidden h-14 shrink-0 border-b border-border bg-card flex items-center justify-between px-4">
      <div class="flex items-center gap-3">
        <button
          class="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-background transition-colors text-muted-foreground"
          @click="mobileMenuOpen = true"
        >
          <Icon name="lucide:menu" size="20" />
        </button>
        <NuxtLink :to="localePath('/dashboard')" class="flex items-center gap-2">
          <AppLogo :size="28" />
          <span class="font-heading text-lg font-bold tracking-tight">FeedLog</span>
        </NuxtLink>
      </div>
      <div class="flex items-center gap-1">
        <ThemeSwitcher />
        <LocaleSwitcher />
      </div>
    </header>

    <!-- Mobile Sheet -->
    <Sheet v-model:open="mobileMenuOpen">
      <SheetContent side="left" class="w-[260px] p-0 flex flex-col">
        <SheetTitle class="sr-only">{{ $t('dashboard.nav.srTitle') }}</SheetTitle>
        <SheetDescription class="sr-only">{{ $t('dashboard.nav.srDescription') }}</SheetDescription>

        <!-- Logo -->
        <div class="p-6">
          <NuxtLink :to="localePath('/dashboard')" class="flex items-center gap-3">
            <AppLogo :size="40" />
            <span class="font-heading text-xl font-bold tracking-tight">FeedLog</span>
          </NuxtLink>
        </div>

        <!-- Navigation -->
        <nav class="scrollbar-subtle flex-1 px-4 space-y-8 overflow-y-auto">
          <div>
            <p class="px-3 mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('dashboard.nav.main') }}</p>
            <div class="space-y-1">
              <NuxtLink
                v-for="item in mainNav"
                :key="item.to"
                :to="localePath(item.to)"
                :aria-disabled="!canVisit(item.to)"
                class="flex items-center gap-3 px-3 py-2 rounded-lg text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
                active-class="!bg-secondary !text-primary !font-bold"
                @click.capture="guardNavigation($event, item.to)"
              >
                <Icon :name="item.icon" size="20" />
                <span class="text-sm">{{ item.label }}</span><span v-if="item.to === '/dashboard/inbox' && inboxCount" class="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] leading-none text-primary-foreground" :aria-label="$t('inbox.unreadOpenCount', { count: inboxCount })"><span class="relative top-px tabular-nums">{{ inboxCount > 99 ? '99+' : inboxCount }}</span></span>
              </NuxtLink>
            </div>
          </div>
          <div>
            <p class="px-3 mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ settingsTitle }}</p>
            <div class="space-y-1">
              <NuxtLink
                v-for="item in settingsNav"
                :key="item.to"
                :to="localePath(item.to)"
                :aria-disabled="!canVisit(item.to)"
                class="flex items-center gap-3 px-3 py-2 rounded-lg text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
                active-class="!bg-secondary !text-primary !font-bold"
                @click.capture="guardNavigation($event, item.to)"
              >
                <Icon :name="item.icon" size="20" />
                <span class="text-sm">{{ item.label }}</span><span v-if="item.to === '/dashboard/inbox' && inboxCount" class="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] leading-none text-primary-foreground" :aria-label="$t('inbox.unreadOpenCount', { count: inboxCount })"><span class="relative top-px tabular-nums">{{ inboxCount > 99 ? '99+' : inboxCount }}</span></span>
              </NuxtLink>
            </div>
          </div>
          <div v-if="developerNav.length">
            <button
              class="w-full flex items-center justify-between px-3 mb-2 group"
              @click="developerOpen = !developerOpen"
            >
              <span class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">{{ $t('dashboard.nav.developer') }}</span>
              <Icon
                :name="developerOpen ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                size="14"
                class="text-muted-foreground"
              />
            </button>
            <div v-show="developerOpen" class="space-y-1">
              <NuxtLink
                v-for="item in developerNav"
                :key="item.to"
                :to="localePath(item.to)"
                :aria-disabled="!canVisit(item.to)"
                class="flex items-center gap-3 px-3 py-2 rounded-lg text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
                active-class="!bg-secondary !text-primary !font-bold"
                @click.capture="guardNavigation($event, item.to)"
              >
                <Icon :name="item.icon" size="20" />
                <span class="text-sm">{{ item.label }}</span><span v-if="item.to === '/dashboard/inbox' && inboxCount" class="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] leading-none text-primary-foreground" :aria-label="$t('inbox.unreadOpenCount', { count: inboxCount })"><span class="relative top-px tabular-nums">{{ inboxCount > 99 ? '99+' : inboxCount }}</span></span>
              </NuxtLink>
            </div>
          </div>
        </nav>

        <OnboardingSidebarEntry mobile />

        <!-- User info -->
        <div class="h-16 px-4 border-t border-border flex items-center">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button class="flex items-center gap-3 flex-1 min-w-0 p-2 rounded-xl hover:bg-background transition-colors">
                <Avatar class="w-8 h-8 shrink-0">
                  <img v-if="avatarUrl && !avatarError" :src="avatarUrl" :alt="user?.name" class="aspect-square size-full rounded-full object-cover" referrerpolicy="no-referrer" @error="avatarError = true">
                  <AvatarFallback v-else class="bg-accent text-accent-foreground text-sm font-bold">
                    {{ initials }}
                  </AvatarFallback>
                </Avatar>
                <div class="flex-1 min-w-0 text-left">
                  <p class="text-xs font-bold truncate">{{ user?.name }}</p>
                  <p class="text-[10px] text-muted-foreground truncate">{{ user?.email }}</p>
                </div>
                <Icon name="lucide:chevron-up" size="16" class="text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" class="w-[228px]">
              <DropdownMenuLabel class="font-normal">
                <div class="flex flex-col space-y-1">
                  <p class="text-sm font-medium">{{ user?.name }}</p>
                  <p class="text-xs text-muted-foreground truncate">{{ user?.email }}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem as-child>
                <NuxtLink :to="localePath('/dashboard/settings/personal')" :aria-current="isPersonalSettings ? 'page' : undefined" :class="{ 'text-primary': isPersonalSettings }">
                  <Icon name="lucide:sliders-horizontal" size="16" class="mr-2" />
                  {{ $t('settings.personal.title') }}
                </NuxtLink>
              </DropdownMenuItem>
              <DropdownMenuItem @click="onEditProfile">
                <Icon name="lucide:user-round-pen" size="16" class="mr-2" />
                {{ $t('nav.editProfile') }}
              </DropdownMenuItem>
              <DropdownMenuItem @click="onChangePassword">
                <Icon name="lucide:key-round" size="16" class="mr-2" />
                {{ $t('nav.changePassword') }}
              </DropdownMenuItem>
              <DropdownMenuItem as-child>
                <NuxtLink :to="localePath('/')">
                  <Icon name="lucide:arrow-left" size="16" class="mr-2" />
                  {{ $t('dashboard.backToSite') }}
                </NuxtLink>
              </DropdownMenuItem>
              <DropdownMenuItem @click="handleSignOut">
                <Icon name="lucide:log-out" size="16" class="mr-2" />
                {{ $t('common.signOut') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SheetContent>
    </Sheet>

    <!-- Desktop Sidebar -->
    <aside class="hidden md:flex w-16 min-[1280px]:w-[260px] h-full shrink-0 border-r border-border bg-card flex-col">
      <div class="hidden min-[1280px]:block">
        <DashboardSidebarBrand />
        <DashboardSidebarTop />
      </div>

      <!-- Navigation -->
      <nav class="scrollbar-subtle flex-1 px-2 min-[1280px]:px-4 pt-4 min-[1280px]:pt-0 space-y-8 overflow-y-auto">
        <!-- Main -->
        <div>
          <p class="hidden min-[1280px]:block px-3 mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('dashboard.nav.main') }}</p>
          <div class="space-y-1">
            <NuxtLink
              v-for="item in mainNav"
              :key="item.to"
              :to="localePath(item.to)"
              :aria-disabled="!canVisit(item.to)"
              class="relative flex items-center gap-3 py-2 rounded-lg justify-center min-[1280px]:justify-start px-0 min-[1280px]:px-3 text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
              :title="item.label"
              active-class="!bg-secondary !text-primary !font-bold"
              @click.capture="guardNavigation($event, item.to)"
            >
              <Icon :name="item.icon" size="20" class="shrink-0" />
              <span class="hidden min-[1280px]:inline text-sm">{{ item.label }}</span>
              <span v-if="item.to === '/dashboard/inbox' && inboxCount" data-inbox-badge class="absolute right-0 top-0 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[9px] leading-none font-semibold text-primary-foreground min-[1280px]:static min-[1280px]:ml-auto min-[1280px]:text-[10px]" :aria-label="$t('inbox.unreadOpenCount', { count: inboxCount })"><span class="relative top-px tabular-nums">{{ inboxCount > 99 ? '99+' : inboxCount }}</span></span>
            </NuxtLink>
          </div>
        </div>

        <!-- Settings -->
        <div>
          <p class="hidden min-[1280px]:block px-3 mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ settingsTitle }}</p>
          <div class="space-y-1">
            <NuxtLink
              v-for="item in settingsNav"
              :key="item.to"
              :to="localePath(item.to)"
              :aria-disabled="!canVisit(item.to)"
              class="flex items-center gap-3 py-2 rounded-lg justify-center min-[1280px]:justify-start px-0 min-[1280px]:px-3 text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
              :title="item.label"
              active-class="!bg-secondary !text-primary !font-bold"
              @click.capture="guardNavigation($event, item.to)"
            >
              <Icon :name="item.icon" size="20" class="shrink-0" />
              <span class="hidden min-[1280px]:inline text-sm">{{ item.label }}</span>
            </NuxtLink>
          </div>
        </div>

        <!-- Developer (collapsible, collapsed by default) -->
        <div v-if="developerNav.length">
          <button
            class="hidden min-[1280px]:flex w-full items-center justify-between px-3 mb-2 group"
            @click="developerOpen = !developerOpen"
          >
            <span class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">{{ $t('dashboard.nav.developer') }}</span>
            <Icon
              :name="developerOpen ? 'lucide:chevron-down' : 'lucide:chevron-right'"
              size="14"
              class="text-muted-foreground"
            />
          </button>
          <div class="space-y-1" :class="developerOpen ? '' : 'min-[1280px]:hidden'">
            <NuxtLink
              v-for="item in developerNav"
              :key="item.to"
              :to="localePath(item.to)"
              :aria-disabled="!canVisit(item.to)"
              class="flex items-center gap-3 py-2 rounded-lg justify-center min-[1280px]:justify-start px-0 min-[1280px]:px-3 text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
              :title="item.label"
              active-class="!bg-secondary !text-primary !font-bold"
              @click.capture="guardNavigation($event, item.to)"
            >
              <Icon :name="item.icon" size="20" class="shrink-0" />
              <span class="hidden min-[1280px]:inline text-sm">{{ item.label }}</span>
            </NuxtLink>
          </div>
        </div>
      </nav>

      <!-- Pinned below one divider, so the scrolling navigation visibly ends above
           both the Getting started entry and the user row. -->
      <div class="border-t border-border">
        <OnboardingSidebarEntry class="pt-3" />

        <!-- User info (bottom) -->
        <div class="flex items-center flex-col min-[1280px]:flex-row gap-1 pb-3 min-[1280px]:pb-0 px-1 min-[1280px]:px-4 min-[1280px]:h-16">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button class="flex items-center gap-3 rounded-xl hover:bg-background transition-colors p-1.5 min-[1280px]:flex-1 min-[1280px]:min-w-0 min-[1280px]:p-2">
                <Avatar class="w-8 h-8 shrink-0">
                  <img v-if="avatarUrl && !avatarError" :src="avatarUrl" :alt="user?.name" class="aspect-square size-full rounded-full object-cover" referrerpolicy="no-referrer" @error="avatarError = true">
                  <AvatarFallback v-else class="bg-accent text-accent-foreground text-sm font-bold">
                    {{ initials }}
                  </AvatarFallback>
                </Avatar>
                <div class="hidden min-[1280px]:block flex-1 min-w-0 text-left">
                  <p class="text-xs font-bold truncate">{{ user?.name }}</p>
                  <p class="text-[10px] text-muted-foreground truncate">{{ user?.email }}</p>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" class="w-[228px]">
              <DropdownMenuLabel class="font-normal">
                <div class="flex flex-col space-y-1">
                  <p class="text-sm font-medium">{{ user?.name }}</p>
                  <p class="text-xs text-muted-foreground truncate">{{ user?.email }}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem as-child>
                <NuxtLink :to="localePath('/dashboard/settings/personal')" :aria-current="isPersonalSettings ? 'page' : undefined" :class="{ 'text-primary': isPersonalSettings }">
                  <Icon name="lucide:sliders-horizontal" size="16" class="mr-2" />
                  {{ $t('settings.personal.title') }}
                </NuxtLink>
              </DropdownMenuItem>
              <DropdownMenuItem @click="onEditProfile">
                <Icon name="lucide:user-round-pen" size="16" class="mr-2" />
                {{ $t('nav.editProfile') }}
              </DropdownMenuItem>
              <DropdownMenuItem @click="onChangePassword">
                <Icon name="lucide:key-round" size="16" class="mr-2" />
                {{ $t('nav.changePassword') }}
              </DropdownMenuItem>
              <DropdownMenuItem as-child>
                <NuxtLink :to="localePath('/')">
                  <Icon name="lucide:arrow-left" size="16" class="mr-2" />
                  {{ $t('dashboard.backToSite') }}
                </NuxtLink>
              </DropdownMenuItem>
              <DropdownMenuItem @click="handleSignOut">
                <Icon name="lucide:log-out" size="16" class="mr-2" />
                {{ $t('common.signOut') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ThemeSwitcher />
          <LocaleSwitcher />
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
      <slot />
    </main>

    <ChangePasswordDialog v-model:open="showChangePassword" />
    <EditProfileDialog v-model:open="showEditProfile" />
    <LoginModal v-model:open="showLoginModal" />
    <OnboardingGuide />
    <OnboardingDemoWidget />
  </div>
</template>
