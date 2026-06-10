<script setup lang="ts">
import { derivePortalThemeVars } from '#layers/feedlog/shared/utils/branding'

const props = defineProps<{
  orgName: string
  logo: string | null
  primaryColor: string
  dark?: boolean
  welcomeTitle?: string
  welcomeDescription?: string
  domain?: string
}>()

const DESIGN_WIDTH = 1160
const frame = ref<HTMLElement | null>(null)
const inner = ref<HTMLElement | null>(null)
const scale = ref(0.5)
const frameHeight = ref(360)
let ro: ResizeObserver | undefined

function update() {
  if (!frame.value || !inner.value) return
  scale.value = frame.value.clientWidth / DESIGN_WIDTH
  frameHeight.value = inner.value.offsetHeight * scale.value
}

onMounted(() => {
  update()
  ro = new ResizeObserver(() => update())
  if (frame.value) ro.observe(frame.value)
  if (inner.value) ro.observe(inner.value)
})
onBeforeUnmount(() => ro?.disconnect())

// The full derived token set is applied to the outer container, so the preview
// renders entirely from these vars and never inherits the dashboard's own theme
// (light/dark) for any token — the preview is self-contained.
const previewStyle = computed(() => derivePortalThemeVars(props.primaryColor, !!props.dark))

// Browser chrome follows light/dark like a real OS window frame would, but uses
// fixed neutral grays (never the portal's brand tokens). Bound to the preview's
// own `dark` prop — not a `dark:` variant — so it tracks the preview toggle and
// stays isolated from the surrounding dashboard theme.
const chromeBorderClass = computed(() => props.dark ? 'border-zinc-700' : 'border-zinc-300')
const chromeBarClass = computed(() => props.dark ? 'bg-zinc-800 border-zinc-700' : 'bg-zinc-100 border-zinc-300')
const chromePillClass = computed(() => props.dark ? 'bg-zinc-900 border-zinc-700 text-zinc-400' : 'bg-white border-zinc-300 text-zinc-500')

const boards = [
  { name: 'All Feedback', count: 128, active: true, icon: 'lucide:layout-grid' },
  { name: 'Feature Requests', count: 86, active: false, icon: 'lucide:folder' },
  { name: 'Bug Reports', count: 31, active: false, icon: 'lucide:folder' },
  { name: 'Integrations', count: 11, active: false, icon: 'lucide:folder' },
]
const posts = [
  { title: 'Dark mode for the dashboard', excerpt: 'Please add a dark theme - staring at the bright dashboard at night is rough.', votes: 128, voted: true, comments: 12, status: 'Planned', board: 'Feature Requests', author: 'AM', time: 'about 22 hours ago' },
  { title: 'Slack notifications on new posts', excerpt: 'We want a Slack alert whenever someone submits feedback so the team can react fast.', votes: 94, voted: false, comments: 7, status: 'Under review', board: 'Integrations', author: 'DI', time: '2 days ago' },
]
</script>

<template>
  <!-- The theme + brand tokens live on this outer container so the mock browser
       chrome AND the portal render in the chosen preview mode, isolated from the
       surrounding dashboard theme. -->
  <div
    class="overflow-hidden rounded-[10px] border bg-background text-foreground shadow-md"
    :class="[{ dark }, chromeBorderClass]"
    :style="previewStyle"
  >
    <!-- Mock browser chrome: macOS-style traffic lights + an address bar showing
         the portal domain and favicon (the favicon reuses the org logo). The chrome
         uses fixed neutral browser grays that flip with the preview's light/dark
         (like an OS window frame), NOT the portal's brand tokens — only the page
         content below carries the brand/theme. -->
    <div class="flex items-center gap-3 h-10 px-3.5 border-b" :class="chromeBarClass">
      <div class="flex items-center gap-2">
        <span class="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <span class="w-3 h-3 rounded-full bg-[#febc2e]" />
        <span class="w-3 h-3 rounded-full bg-[#28c840]" />
      </div>
      <div class="flex-1 min-w-0 flex items-center gap-1.5 h-6 px-3 rounded-full border text-[11px]" :class="chromePillClass">
        <img v-if="logo" :src="logo" alt="" class="w-3.5 h-3.5 rounded-sm object-contain shrink-0">
        <Icon v-else name="lucide:globe" size="12" class="shrink-0 opacity-70" />
        <span class="truncate">{{ domain }}</span>
      </div>
    </div>

    <!-- Scaled portal page -->
    <div ref="frame" class="relative w-full overflow-hidden" :style="{ height: frameHeight + 'px' }">
      <div ref="inner" class="absolute left-0 top-0 origin-top-left" :style="{ width: DESIGN_WIDTH + 'px', transform: `scale(${scale})` }">
        <div class="bg-background text-foreground font-body">
          <header class="border-b border-border bg-card">
            <div class="h-16 flex items-center justify-between px-8">
              <div class="flex items-center gap-8">
                <div class="flex items-center gap-3">
                  <img v-if="logo" :src="logo" alt="" class="w-9 h-9 rounded-lg object-contain shrink-0">
                  <div v-else class="w-9 h-9 rounded-lg grid place-items-center bg-primary text-primary-foreground font-heading font-bold shrink-0">
                    {{ orgName.charAt(0) }}
                  </div>
                  <span class="font-heading text-xl font-bold tracking-tight">{{ orgName }}</span>
                </div>
                <nav class="flex items-center gap-6 text-sm font-bold">
                  <span class="flex items-center gap-2 text-primary"><Icon name="lucide:message-square" size="18" />Feedback</span>
                  <span class="flex items-center gap-2 text-muted-foreground"><Icon name="lucide:map" size="18" />Roadmap</span>
                  <span class="flex items-center gap-2 text-muted-foreground"><Icon name="lucide:newspaper" size="18" />Changelog</span>
                </nav>
              </div>
              <button class="flex items-center gap-2 font-heading font-semibold text-sm px-4 py-2 rounded-lg bg-primary text-primary-foreground">
                <Icon name="lucide:log-in" size="16" />Sign in
              </button>
            </div>
          </header>

          <div class="flex gap-8 px-8 py-8">
            <aside class="w-[260px] shrink-0">
              <div class="font-heading text-lg font-bold mb-4">Boards</div>
              <nav class="flex flex-col gap-2">
                <div
                  v-for="b in boards"
                  :key="b.name"
                  class="flex items-center justify-between px-4 py-3 rounded-lg font-medium"
                  :class="b.active ? 'bg-secondary text-primary' : 'text-muted-foreground'"
                >
                  <div class="flex items-center gap-3"><Icon :name="b.icon" size="18" /><span>{{ b.name }}</span></div>
                  <span class="text-xs px-2 py-0.5 rounded-full font-bold" :class="b.active ? 'bg-card text-primary' : 'bg-background'">{{ b.count }}</span>
                </div>
              </nav>
              <div class="mt-8">
                <span class="inline-flex items-center gap-1.5 px-4 text-[11px] text-muted-foreground">
                  <Icon name="lucide:zap" size="12" class="opacity-70" />
                  Powered by <span class="font-medium">FeedLog</span>
                </span>
              </div>
            </aside>

            <section class="flex-1 flex flex-col gap-6 min-w-0">
              <div class="rounded-xl border border-primary/20 bg-primary/5 px-6 py-5">
                <h2 class="font-heading text-xl font-bold">{{ welcomeTitle || `Submit feedback for ${orgName}` }}</h2>
                <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {{ welcomeDescription || 'Any bug reports and feature requests are welcome - tell us what would make this product better.' }}
                </p>
              </div>

              <div class="flex items-center justify-between">
                <h3 class="text-xs font-bold uppercase tracking-wider text-muted-foreground">Recent Requests</h3>
                <div class="flex items-center gap-3">
                  <div class="flex bg-border/50 p-1 rounded-lg">
                    <span class="px-4 py-1.5 rounded-[12px] text-sm font-medium text-muted-foreground">Top</span>
                    <span class="px-4 py-1.5 rounded-[12px] text-sm font-medium bg-card text-foreground shadow-sm">Recent</span>
                  </div>
                  <button class="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-[15px] font-heading font-semibold inline-flex items-center gap-1.5">
                    <Icon name="lucide:plus" size="18" />New Request
                  </button>
                </div>
              </div>

              <div class="flex flex-col gap-4">
                <div v-for="p in posts" :key="p.title" class="flex items-stretch gap-4 bg-card border border-border rounded-lg p-4">
                  <div class="w-[56px] h-[64px] shrink-0 rounded-md flex flex-col items-center justify-center gap-1 border" :class="p.voted ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-foreground border-border'">
                    <Icon name="lucide:chevron-up" size="24" />
                    <span class="font-heading font-bold text-[15px] leading-none">{{ p.votes }}</span>
                  </div>
                  <div class="flex-1 flex flex-col justify-center min-w-0 py-1">
                    <div class="flex items-center gap-2 mb-1 text-xs font-medium text-muted-foreground">
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full border border-border bg-background">{{ p.status }}</span>
                      <span>• {{ p.board }}</span>
                    </div>
                    <h3 class="font-heading text-lg font-bold leading-tight truncate">{{ p.title }}</h3>
                    <p class="text-sm text-muted-foreground line-clamp-2 mt-1">{{ p.excerpt }}</p>
                    <div class="flex items-center gap-4 mt-3 text-xs text-muted-foreground font-medium">
                      <div class="flex items-center gap-1.5"><Icon name="lucide:message-square" size="14" /><span>{{ p.comments }} comments</span></div>
                      <div class="flex items-center gap-2">
                        <div class="w-5 h-5 rounded-full bg-foreground/10 flex items-center justify-center text-foreground font-bold text-[9px]">{{ p.author }}</div>
                        <div class="flex items-center gap-1.5"><Icon name="lucide:clock" size="14" /><span>{{ p.time }}</span></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
