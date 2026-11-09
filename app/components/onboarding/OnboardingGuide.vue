<script setup lang="ts">
import { ONBOARDING_DEMO_SLIDE, ONBOARDING_SLIDES } from '#layers/feedlog/app/composables/useOnboarding'

// Slide guide for a new workspace. The first slides show short screen recordings;
// the last one is about the two next steps, so it shows a short line instead.
const { state, setSlide, closeGuide, tryDemo, goInstall } = useOnboarding()
const { t } = useI18n()

// Recordings are MP4 rather than GIF to keep them small. Encoded at 1440px wide
// (2x the widest dialog), 30 fps, no audio, faststart.
const MEDIA: Partial<Record<typeof ONBOARDING_SLIDES[number], string>> = {
  widget: '/onboarding/widget',
  inbox: '/onboarding/inbox',
  feedback: '/onboarding/feedback',
}

const slides = computed(() => ONBOARDING_SLIDES.map(key => ({
  key,
  title: t(`onboarding.guide.slides.${key}.title`),
  body: t(`onboarding.guide.slides.${key}.body`),
  image: t(`onboarding.guide.slides.${key}.image`),
  media: MEDIA[key],
  cta: key === ONBOARDING_DEMO_SLIDE,
  // The first slide already points developers at the guide; the last one offers it as a button.
  installLink: key === ONBOARDING_SLIDES[0],
})))
const slide = computed(() => slides.value[state.value.slide]!)
const isLast = computed(() => state.value.slide === slides.value.length - 1)
const open = computed({
  get: () => state.value.guideOpen,
  set: (value) => { if (!value) closeGuide() },
})

// Only the visible recording plays, restarting from its first frame; the next
// one is fetched ahead so it is ready when the user moves on.
const videos = ref<Record<string, HTMLVideoElement | null>>({})
const reducedMotion = import.meta.client && matchMedia('(prefers-reduced-motion: reduce)').matches
function preloadFor(index: number) {
  return index === state.value.slide || index === state.value.slide + 1 ? 'auto' : 'none'
}
// Pausing holds the current slide only: the next slide starts playing again.
// With reduced motion every slide starts paused and the user chooses to play.
const paused = ref(reducedMotion)
const progress = ref(0)
const currentVideo = () => videos.value[slide.value.key] ?? null

// Instead of `loop`, each recording holds its last frame for a moment before
// starting over, so the ending can be read and the restart is not an abrupt cut.
const LOOP_HOLD_MS = 1000
let holdTimer: ReturnType<typeof setTimeout> | undefined
function onEnded(key: string) {
  clearTimeout(holdTimer)
  holdTimer = setTimeout(() => {
    if (key === slide.value.key) sync()
  }, LOOP_HOLD_MS)
}

// play() on an ended video starts it again from the first frame.
function sync() {
  clearTimeout(holdTimer)
  slides.value.forEach((item, index) => {
    const video = videos.value[item.key]
    if (!video) return
    if (state.value.guideOpen && index === state.value.slide && !paused.value) void video.play().catch(() => {})
    else video.pause()
  })
}
watch(() => [state.value.guideOpen, state.value.slide] as const, async () => {
  await nextTick()
  paused.value = reducedMotion
  const video = currentVideo()
  if (video) video.currentTime = 0
  progress.value = 0
  sync()
}, { immediate: true })
watch(paused, sync)

// timeupdate fires only a few times a second; the ring follows frames instead.
let frame = 0
function track() {
  const video = currentVideo()
  if (video?.duration) progress.value = video.currentTime / video.duration
  frame = requestAnimationFrame(track)
}
watch(() => state.value.guideOpen, (open) => {
  if (!import.meta.client) return
  cancelAnimationFrame(frame)
  if (open) frame = requestAnimationFrame(track)
}, { immediate: true })
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  clearTimeout(holdTimer)
})

// Start focus on the dialog itself: the first control is the media pause button,
// and a focus ring there on the automatic first opening reads as a stray outline.
// Tab still reaches every control in order.
function focusDialog(event: Event) {
  event.preventDefault()
  ;(event.target as HTMLElement | null)?.focus()
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowRight' && !isLast.value) setSlide(state.value.slide + 1)
  if (event.key === 'ArrowLeft' && state.value.slide > 0) setSlide(state.value.slide - 1)
}
</script>

<template>
  <Dialog v-model:open="open">
    <!-- Width also follows the viewport height so the 16:9 recording is never cropped:
         226px covers the copy (up to three lines) and footer, so the whole dialog fits a
         580px-tall viewport. Below that it keeps that size (530px) and scrolls inside:
         shrinking further would make the recordings unreadable. Block, not the dialog's
         default grid: grid rows would squeeze the media instead of scrolling. -->
    <DialogContent class="scrollbar-subtle scrollbar-contrast sm:max-w-[max(530px,min(720px,calc((100dvh_-_2rem_-_226px)*16/9)))] block max-h-[calc(100dvh-2rem)] overflow-y-auto overflow-x-hidden border-0 bg-transparent p-0 focus:outline-none" :show-close-button="false" data-onboarding-guide @keydown="onKey" @open-auto-focus="focusDialog">
      <DialogTitle class="sr-only">{{ $t('onboarding.guide.srTitle') }}</DialogTitle>
      <DialogDescription class="sr-only">{{ $t('onboarding.guide.srDescription') }}</DialogDescription>

      <!-- Only the dialog clips the top corners. A transparent backdrop avoids
           a pale seam where the video and dialog are composited at the edge. -->
      <div
        class="relative aspect-video border-b border-border overflow-hidden"
        :class="!slide.media && 'bg-[color-mix(in_oklab,var(--secondary)_60%,var(--background))]'"
      >
        <!-- Recordings stay mounted and are cross-faded, so going back does not refetch. -->
        <template v-for="(item, index) in slides" :key="item.key">
          <video
            v-if="item.media"
            :ref="el => { videos[item.key] = el as HTMLVideoElement | null }"
            :poster="`${item.media}.webp`"
            :preload="preloadFor(index)"
            class="absolute inset-0 size-full object-cover transition-opacity duration-200"
            :class="index === state.slide ? 'opacity-100' : 'opacity-0'"
            :aria-hidden="index !== state.slide"
            :aria-label="item.image"
            muted playsinline disablepictureinpicture
            data-onboarding-media
            @ended="onEnded(item.key)"
          >
            <source :src="`${item.media}.mp4`" type="video/mp4">
          </video>
        </template>
        <OnboardingMediaControl v-if="slide.media" class="absolute bottom-3 right-3 z-10" :paused="paused" :progress="progress" @toggle="paused = !paused" />
        <Transition name="onboarding-slide">
          <!-- No frame inside the dialog: the tint fills the media area edge to edge. -->
          <div v-if="!slide.media" class="absolute inset-0 grid place-items-center bg-[radial-gradient(ellipse_at_center,color-mix(in_oklab,var(--primary)_14%,transparent),transparent_70%)]">
            <div class="flex flex-col items-center gap-4 px-8 text-center">
              <span class="grid size-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
                <Icon name="lucide:rocket" size="26" />
              </span>
              <p class="font-heading text-2xl font-bold leading-tight text-foreground">{{ slide.image }}</p>
            </div>
          </div>
        </Transition>
      </div>

      <DialogClose
        type="button"
        class="absolute top-4 right-4 z-20 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:pointer-events-none [&_svg]:pointer-events-none"
        :aria-label="$t('onboarding.guide.close')"
        data-onboarding-close
      >
        <Icon name="lucide:x" size="16" />
      </DialogClose>

      <!-- Every slide sits in the same grid cell, so the copy area always takes the
           height of the longest slide and the footer never moves between slides. -->
      <div class="grid bg-background px-8 pt-6 pb-4">
        <div
          v-for="(item, index) in slides" :key="item.key"
          class="[grid-area:1/1] transition-[opacity,transform] duration-200 ease-out"
          :class="index === state.slide ? 'opacity-100 translate-x-0' : ['invisible opacity-0', index < state.slide ? '-translate-x-3' : 'translate-x-3']"
          :aria-hidden="index !== state.slide"
        >
          <h2 class="font-heading text-xl font-bold leading-snug">{{ item.title }}</h2>
          <!-- Body copy is the slide's main message, so it is darker than the app's muted grey
               (65% foreground passes 4.5:1) while the darker link still stands out at 3:1. -->
          <p class="mt-2 text-sm leading-relaxed text-foreground/65">
            {{ item.body }}
            <template v-if="item.installLink && !item.cta">{{ `${$t('onboarding.guide.readyToIntegrate')} ` }}</template>
            <!-- Secondary path, inline so these slides' copy is no taller than the others;
                 same wording as the install link in the Demo Widget frame. -->
            <button v-if="item.installLink" type="button" class="inline-flex items-center gap-1 whitespace-nowrap text-sm font-semibold text-foreground underline-offset-4 hover:underline" data-fdl-action="onboarding_install" data-fdl-source="guide_inline" data-onboarding-install @click="goInstall()">
              {{ $t('onboarding.guide.install') }}<Icon name="lucide:arrow-right" size="14" />
            </button>
          </p>
        </div>
      </div>

      <div class="bg-background px-8 py-5 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-1.5">
          <button
            v-for="(item, index) in slides" :key="item.key" type="button"
            class="h-1.5 rounded-full transition-all"
            :class="index === state.slide ? 'w-6 bg-primary' : 'w-1.5 bg-border hover:bg-muted-foreground/40'"
            :aria-label="$t('onboarding.guide.slideLabel', { n: index + 1 })"
            @click="setSlide(index)"
          />
        </div>
        <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
          <!-- Back is always present and the primary button keeps its right edge, so
               the controls do not jump between slides. On the last slide the two next
               steps take their place; the dots still lead back, and closing is left to
               the dialog's close button. -->
          <button v-if="!slide.cta" type="button" class="h-9 w-[72px] rounded-lg border border-border text-xs font-heading font-bold hover:bg-secondary transition-colors" :class="state.slide === 0 && 'invisible'" :tabindex="state.slide === 0 ? -1 : 0" @click="setSlide(state.slide - 1)">{{ $t('onboarding.guide.back') }}</button>
          <button v-else type="button" class="h-9 px-3.5 whitespace-nowrap rounded-lg border border-border text-[13px] font-heading font-bold hover:bg-secondary transition-colors flex items-center gap-1.5" data-fdl-action="onboarding_install" data-fdl-source="guide" data-onboarding-install @click="goInstall()">
            <Icon name="lucide:code-xml" size="15" />{{ $t('onboarding.guide.install') }}
          </button>
          <button v-if="slide.cta" type="button" class="h-9 min-w-[104px] px-3.5 whitespace-nowrap rounded-lg bg-primary text-primary-foreground text-[13px] font-heading font-bold hover:opacity-90 transition-all flex items-center justify-center gap-1.5" data-fdl-action="onboarding_try_demo" data-fdl-source="guide" data-onboarding-try-demo @click="tryDemo()">
            <Icon name="lucide:message-circle" size="15" />{{ $t('onboarding.guide.tryDemo') }}
          </button>
          <button v-else type="button" class="h-9 w-[104px] rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-opacity" data-onboarding-next @click="setSlide(state.slide + 1)">{{ $t('onboarding.guide.next') }}</button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style>
.onboarding-slide-enter-active, .onboarding-slide-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.onboarding-slide-enter-from { opacity: 0; transform: translateX(12px); }
.onboarding-slide-leave-to { opacity: 0; transform: translateX(-12px); }
</style>
