<script setup lang="ts">
import { resolveAttachmentUrl } from '#layers/feedlog/app/utils/attachment'

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

const { isOpen: showLoginModal } = useLoginModal()

async function handleSignOut() {
  await signOut()
  session.value = null
  navigateTo(localePath('/'))
}

const { mainNav, aiNav, personalNav, productNav, settingsNav } = useDashboardNav()
const { t } = useI18n()
const route = useRoute()
const { suspendedBlocked } = useDashboardAccess()
const pageBlocked = computed(() => suspendedBlocked(route.path.replace(/^\/(?:en|zh)(?=\/|$)/, '')))
const mobileMenuOpen = ref(false)
watch(() => route.path, () => { mobileMenuOpen.value = false })

const sidebarExpanded = ref(false)
const sidebarPreference = 'feedlog.dashboard.sidebar.expanded'
onMounted(() => {
  try { sidebarExpanded.value = localStorage.getItem(sidebarPreference) === 'true' } catch { /* Use the default width. */ }
})
function toggleSidebar() {
  sidebarExpanded.value = !sidebarExpanded.value
  try { localStorage.setItem(sidebarPreference, String(sidebarExpanded.value)) } catch { /* Keep the choice for this visit. */ }
}

function isCurrent(path: string, includeChildren = false) {
  const target = localePath(path)
  const current = route.path.replace(/\/$/, '')
  return current === target || (includeChildren && current.startsWith(`${target}/`))
}
const settingsGroups = computed(() => [
  { label: t('dashboard.nav.personalGroup'), items: personalNav.value },
  { label: t('dashboard.nav.productGroup'), items: productNav.value },
  { label: t('dashboard.nav.workspaceGroup'), items: settingsNav.value },
])
const settingsItems = computed(() => settingsGroups.value.flatMap(group => group.items))
const settingsEntry = computed(() => ({
  label: t('dashboard.nav.settingsTitle'),
  to: settingsNav.value[0]!.to,
  icon: 'lucide:settings',
}))
const inAgent = computed(() => isCurrent('/dashboard/ai-agent', true))
const inSettings = computed(() => settingsItems.value.some(item => isCurrent(item.to, true)))
const personalEntry = computed(() => personalNav.value[0]!.to)
const isProfileEntry = computed(() => isCurrent(personalEntry.value))
const navTitle = computed(() => {
  const items = inAgent.value ? aiNav.value : [...mainNav.value, ...settingsItems.value]
  const match = items.find(item => isCurrent(item.to))
    ?? items.find(item => isCurrent(item.to, true))
  return match?.label ?? t('nav.dashboard')
})
useHead({ title: () => navTitle.value })

const { count: inboxCount, refresh: refreshInboxCount } = useInboxBadge()
const { canAccessInbox } = usePermission(computed(() => undefined), 'post')
let inboxTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  if (canAccessInbox.value) void refreshInboxCount()
  inboxTimer = setInterval(() => { if (!document.hidden && canAccessInbox.value) void refreshInboxCount() }, 10000)
})
onBeforeUnmount(() => clearInterval(inboxTimer))

const onboarding = useOnboarding()
// Resolved by the dashboard middleware before any dashboard page renders, so the
// guide opens as soon as the page hydrates.
const onboardingStatus = useState<{ autoOpen: boolean } | null>('onboarding-status')
onMounted(() => onboarding.load(onboardingStatus.value?.autoOpen === true))
</script>

<template>
  <div class="h-dvh overflow-hidden flex flex-col md:flex-row bg-background text-foreground font-body">
    <!-- Mobile header -->
    <header class="md:hidden h-14 shrink-0 border-b border-border bg-card flex items-center justify-between px-4">
      <div class="flex items-center gap-3">
        <button
          class="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-background transition-colors text-muted-foreground"
          :aria-label="$t('dashboard.nav.srTitle')"
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

        <DashboardSidebarBrand />
        <DashboardSidebarTop />

        <nav class="scrollbar-subtle min-h-0 flex-1 space-y-1 overflow-y-auto px-4" :aria-label="$t('dashboard.nav.srTitle')">
          <p class="mb-2 px-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('dashboard.nav.main') }}</p>
          <DashboardNavigationLink
            v-for="item in mainNav"
            :key="item.to"
            :item="item"
            :selected="isCurrent(item.to, true)"
            :unread="item.to === '/dashboard/inbox' ? inboxCount : undefined"
            @click="mobileMenuOpen = false"
          />
        </nav>

        <div class="border-t border-border pt-3">
          <OnboardingSidebarEntry mobile @open="mobileMenuOpen = false" />
          <DashboardNavigationLink :item="settingsEntry" :selected="inSettings" class="mx-4 mb-3" @click="mobileMenuOpen = false" />
        </div>

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
                <NuxtLink :to="localePath(personalEntry)" :aria-current="isProfileEntry ? 'page' : undefined" :class="{ 'text-primary': isProfileEntry }">
                  <Icon name="lucide:sliders-horizontal" size="16" class="mr-2" />
                  {{ $t('settings.personal.title') }}
                </NuxtLink>
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

    <aside
      class="dashboard-primary relative hidden h-full w-[260px] shrink-0 flex-col border-r border-border bg-card md:flex"
      :class="{ 'dashboard-primary-compact': !sidebarExpanded }"
      :aria-label="$t('dashboard.nav.srTitle')"
    >
      <div class="flex h-18 shrink-0 flex-col justify-center">
        <DashboardSidebarBrand :compact="!sidebarExpanded" />
        <DashboardSidebarTop :compact="!sidebarExpanded" />
      </div>

      <button
        type="button"
        class="absolute top-1/2 -right-3 z-10 grid size-6 -translate-y-1/2 place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        :title="$t(sidebarExpanded ? 'dashboard.nav.collapse' : 'dashboard.nav.expand')"
        :aria-label="$t(sidebarExpanded ? 'dashboard.nav.collapse' : 'dashboard.nav.expand')"
        :aria-expanded="sidebarExpanded"
        aria-controls="dashboard-primary-links"
        data-dashboard-sidebar-toggle
        @click="toggleSidebar"
      >
        <Icon :name="sidebarExpanded ? 'lucide:chevron-left' : 'lucide:chevron-right'" size="14" />
      </button>

      <nav id="dashboard-primary-links" class="scrollbar-subtle min-h-0 flex-1 space-y-1 overflow-y-auto px-2">
        <p class="dashboard-primary-caption mb-2 px-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('dashboard.nav.main') }}</p>
        <DashboardNavigationLink
          v-for="item in mainNav"
          :key="item.to"
          :item="item"
          :selected="isCurrent(item.to, true)"
          :unread="item.to === '/dashboard/inbox' ? inboxCount : undefined"
        />
      </nav>

      <div class="shrink-0 border-t border-border px-2 pt-3">
        <OnboardingSidebarEntry :compact="!sidebarExpanded" />
        <DashboardNavigationLink :item="settingsEntry" :selected="inSettings" class="mb-3" />

        <!-- User info (bottom) -->
        <div class="dashboard-primary-account flex h-16 items-center gap-1 px-2">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                :aria-label="$t('dashboard.nav.account')"
                class="dashboard-primary-profile flex min-w-0 flex-1 items-center gap-3 rounded-xl p-2 transition-colors hover:bg-background">
                <Avatar class="w-8 h-8 shrink-0">
                  <img v-if="avatarUrl && !avatarError" :src="avatarUrl" :alt="user?.name" class="aspect-square size-full rounded-full object-cover" referrerpolicy="no-referrer" @error="avatarError = true">
                  <AvatarFallback v-else class="bg-accent text-accent-foreground text-sm font-bold">
                    {{ initials }}
                  </AvatarFallback>
                </Avatar>
                <div class="dashboard-nav-label flex-1 min-w-0 text-left">
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
                <NuxtLink :to="localePath(personalEntry)" :aria-current="isProfileEntry ? 'page' : undefined" :class="{ 'text-primary': isProfileEntry }">
                  <Icon name="lucide:sliders-horizontal" size="16" class="mr-2" />
                  {{ $t('settings.personal.title') }}
                </NuxtLink>
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

    <!-- The notice bar spans the secondary navigation and the page, so it sits in the same place on every screen. -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <DashboardNoticeBar />
      <div class="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <aside
          v-if="inAgent || inSettings"
          class="dashboard-secondary flex shrink-0 flex-col border-b border-border bg-card md:w-52 md:border-r md:border-b-0 xl:w-60"
          :aria-label="$t(inAgent ? 'dashboard.agent.title' : 'dashboard.nav.settingsTitle')"
        >
          <header class="flex h-11 shrink-0 items-center px-4 md:h-16 md:border-b md:border-border md:px-5">
            <h2 class="font-heading text-lg font-bold">{{ $t(inAgent ? 'dashboard.agent.title' : 'dashboard.nav.settingsTitle') }}</h2>
          </header>
          <nav class="dashboard-secondary-links scrollbar-subtle flex items-center gap-1 overflow-x-auto px-3 pb-2 md:block md:space-y-1 md:overflow-y-auto md:px-3 md:py-4">
            <template v-if="inAgent">
              <DashboardNavigationLink v-for="item in aiNav" :key="item.to" :item="item" :selected="isCurrent(item.to)" />
            </template>
            <template v-else>
              <template v-for="(group, index) in settingsGroups" :key="group.label">
                <p class="dashboard-secondary-group" :class="index > 0 && 'md:mt-5!'">{{ group.label }}</p>
                <DashboardNavigationLink v-for="item in group.items" :key="item.to" :item="item" :selected="isCurrent(item.to, true)" />
              </template>
            </template>
          </nav>
        </aside>

        <!-- Main content -->
        <main class="dashboard-content flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <MemberSuspendedNotice v-if="pageBlocked" />
          <slot v-else />
        </main>
      </div>
    </div>

    <DashboardExtensions />
    <LoginModal v-model:open="showLoginModal" />
    <OnboardingGuide />
    <OnboardingDemoWidget />
  </div>
</template>

<style scoped>
.dashboard-primary-compact { width: 64px; }
.dashboard-primary-compact :deep(.dashboard-nav-label) { display: none; }
.dashboard-primary-compact .dashboard-primary-caption { visibility: hidden; white-space: nowrap; overflow: hidden; }
.dashboard-primary-compact :deep(.dashboard-nav-link) { gap: 0; }
.dashboard-primary-compact :deep(.dashboard-nav-badge) { position: absolute; top: 0; right: 0; font-size: 9px; }
.dashboard-primary-compact .dashboard-primary-account { height: auto; flex-direction: column; padding: 0 0 12px; }
.dashboard-primary-compact .dashboard-primary-profile { flex: none; }
.dashboard-secondary-group {
  padding: 4px 8px;
  color: var(--muted-foreground);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.dashboard-secondary :deep(.dashboard-nav-link) { gap: 10px; padding-block: 7px; }
.dashboard-secondary :deep(.dashboard-nav-label) { font-size: 13px; }
@media (width < 48rem) {
  .dashboard-secondary :deep(.dashboard-nav-link), .dashboard-secondary-group { flex: none; }
}
@media (width >= 48rem) {
  .dashboard-secondary-group { padding-inline: 12px; }
  .dashboard-secondary :deep(.dashboard-nav-label) { white-space: normal; }
}
</style>
