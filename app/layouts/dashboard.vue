<script setup lang="ts">
const { signOut } = useAuth()
const { data: session } = await useAuthSession()

const user = computed(() => session.value?.user)

const initials = computed(() => {
  const name = user.value?.name || ''
  return name.slice(0, 2).toUpperCase()
})

const avatarError = ref(false)
watch(user, () => { avatarError.value = false })

const showChangePassword = ref(false)

async function handleSignOut() {
  await signOut()
  session.value = null
  navigateTo('/')
}

const { mainNav, settingsNav } = useDashboardNav()

// Mobile menu
const mobileMenuOpen = ref(false)
const route = useRoute()
watch(() => route.path, () => { mobileMenuOpen.value = false })
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
        <NuxtLink to="/dashboard" class="flex items-center gap-2">
          <AppLogo :size="28" />
          <span class="font-heading text-lg font-bold tracking-tight">FeedLog</span>
        </NuxtLink>
      </div>
    </header>

    <!-- Mobile Sheet -->
    <Sheet v-model:open="mobileMenuOpen">
      <SheetContent side="left" class="w-[260px] p-0 flex flex-col">
        <SheetTitle class="sr-only">Navigation</SheetTitle>
        <SheetDescription class="sr-only">Dashboard navigation menu</SheetDescription>

        <!-- Logo -->
        <div class="p-6">
          <NuxtLink to="/dashboard" class="flex items-center gap-3">
            <AppLogo :size="40" />
            <span class="font-heading text-xl font-bold tracking-tight">FeedLog</span>
          </NuxtLink>
        </div>

        <!-- Navigation -->
        <nav class="flex-1 px-4 space-y-8 overflow-y-auto">
          <div>
            <p class="px-3 mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Main</p>
            <div class="space-y-1">
              <NuxtLink
                v-for="item in mainNav"
                :key="item.to"
                :to="item.to"
                class="flex items-center gap-3 px-3 py-2 rounded-lg text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
                active-class="!bg-secondary !text-primary !font-bold"
              >
                <Icon :name="item.icon" size="20" />
                <span class="text-sm">{{ item.label }}</span>
              </NuxtLink>
            </div>
          </div>
          <div>
            <p class="px-3 mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Settings</p>
            <div class="space-y-1">
              <NuxtLink
                v-for="item in settingsNav"
                :key="item.to"
                :to="item.to"
                class="flex items-center gap-3 px-3 py-2 rounded-lg text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
                active-class="!bg-secondary !text-primary !font-bold"
              >
                <Icon :name="item.icon" size="20" />
                <span class="text-sm">{{ item.label }}</span>
              </NuxtLink>
            </div>
          </div>
        </nav>

        <!-- User info -->
        <div class="h-16 px-4 border-t border-border flex items-center">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button class="flex items-center gap-3 w-full p-2 rounded-xl hover:bg-background transition-colors">
                <Avatar class="w-8 h-8 shrink-0">
                  <img v-if="user?.image && !avatarError" :src="user.image" :alt="user?.name" class="aspect-square size-full rounded-full object-cover" referrerpolicy="no-referrer" @error="avatarError = true">
                  <AvatarFallback v-else class="bg-accent text-accent-foreground text-sm font-bold">
                    {{ initials }}
                  </AvatarFallback>
                </Avatar>
                <div class="flex-1 text-left">
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
              <DropdownMenuItem @click="showChangePassword = true">
                <Icon name="lucide:key-round" size="16" class="mr-2" />
                Change Password
              </DropdownMenuItem>
              <DropdownMenuItem as-child>
                <NuxtLink to="/">
                  <Icon name="lucide:arrow-left" size="16" class="mr-2" />
                  Back to site
                </NuxtLink>
              </DropdownMenuItem>
              <DropdownMenuItem @click="handleSignOut">
                <Icon name="lucide:log-out" size="16" class="mr-2" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SheetContent>
    </Sheet>

    <!-- Desktop Sidebar -->
    <aside class="hidden md:flex w-[260px] h-full shrink-0 border-r border-border bg-card flex-col">
      <DashboardSidebarBrand />
      <DashboardSidebarTop />

      <!-- Navigation -->
      <nav class="flex-1 px-4 space-y-8 overflow-y-auto">
        <!-- Main -->
        <div>
          <p class="px-3 mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Main</p>
          <div class="space-y-1">
            <NuxtLink
              v-for="item in mainNav"
              :key="item.to"
              :to="item.to"
              class="flex items-center gap-3 px-3 py-2 rounded-lg text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
              active-class="!bg-secondary !text-primary !font-bold"
            >
              <Icon :name="item.icon" size="20" />
              <span class="text-sm">{{ item.label }}</span>
            </NuxtLink>
          </div>
        </div>

        <!-- Settings -->
        <div>
          <p class="px-3 mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Settings</p>
          <div class="space-y-1">
            <NuxtLink
              v-for="item in settingsNav"
              :key="item.to"
              :to="item.to"
              class="flex items-center gap-3 px-3 py-2 rounded-lg text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
              active-class="!bg-secondary !text-primary !font-bold"
            >
              <Icon :name="item.icon" size="20" />
              <span class="text-sm">{{ item.label }}</span>
            </NuxtLink>
          </div>
        </div>
      </nav>

      <!-- User info (bottom) -->
      <div class="h-16 px-4 border-t border-border flex items-center">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button class="flex items-center gap-3 w-full p-2 rounded-xl hover:bg-background transition-colors">
              <Avatar class="w-8 h-8 shrink-0">
                <img v-if="user?.image && !avatarError" :src="user.image" :alt="user?.name" class="aspect-square size-full rounded-full object-cover" referrerpolicy="no-referrer" @error="avatarError = true">
                <AvatarFallback v-else class="bg-accent text-accent-foreground text-sm font-bold">
                  {{ initials }}
                </AvatarFallback>
              </Avatar>
              <div class="flex-1 text-left">
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
            <DropdownMenuItem @click="showChangePassword = true">
              <Icon name="lucide:key-round" size="16" class="mr-2" />
              Change Password
            </DropdownMenuItem>
            <DropdownMenuItem as-child>
              <NuxtLink to="/">
                <Icon name="lucide:arrow-left" size="16" class="mr-2" />
                Back to site
              </NuxtLink>
            </DropdownMenuItem>
            <DropdownMenuItem @click="handleSignOut">
              <Icon name="lucide:log-out" size="16" class="mr-2" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
      <slot />
    </main>

    <ChangePasswordDialog v-model:open="showChangePassword" />
  </div>
</template>
