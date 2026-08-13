<script setup lang="ts">
import { resolveAttachmentUrl } from '~/utils/attachment'
import { widgetEmbedKey } from '~/composables/useWidgetEmbed'
import { widgetProtocolKey } from '~/composables/useWidgetProtocol'

const props = defineProps<{
  productName: string
  openId: string | null
}>()

const emit = defineEmits<{
  authRequired: []
  filed: []
  replied: [id: string]
}>()

const { t } = useI18n()
const { user, widgetFetch } = inject(widgetEmbedKey)!
const protocol = inject(widgetProtocolKey)!

type WidgetAiType = 'feedback' | 'support' | 'clarify' | 'unrecognized'

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  images?: string[]
  // No type on an assistant bubble = the send failed; that notice is local and
  // must never be replayed to the model.
  type?: WidgetAiType
  post?: { id: string, slug: string, title: string, board: string | null, status: string }
}

const messages = ref<ChatMessage[]>([])
const conversationId = ref<string | null>(null)
const draft = ref('')
const sending = ref(false)
const loadingThread = ref(false)
const fullCarry = ref<{ text: string, files: Attachment[] } | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
const draftEl = ref<HTMLTextAreaElement | null>(null)

// min-h-12 is the resting height and nothing else grows the box, so it is
// measured against its own content on every change. Resetting to auto first is
// what makes it shrink again: scrollHeight otherwise keeps reporting the taller
// box it already is. max-h-[120px] caps the growth and hands over to the scrollbar.
watch(draft, () => {
  const el = draftEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}, { flush: 'post' })

// ---- attachments ---------------------------------------------------------
// Uploaded up front rather than on send: the storage key is what the message
// endpoint wants, and uploading early lets a failure surface while the visitor
// is still composing.
// Mirrors `ensure.maxSize` in server/api/upload.post.ts.
const MAX_UPLOAD_MB = 10
interface Attachment { key: string, name: string }
const attachments = ref<Attachment[]>([])
const pendingUploads = ref(0)
const uploading = computed(() => pendingUploads.value > 0)
const uploadError = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  void uploadFiles(files)
}

function onPaste(e: ClipboardEvent) {
  const images = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'))
  if (!images.length) return
  // A copied file carries its name as text/plain; without this it lands in the draft.
  e.preventDefault()
  void uploadFiles(images)
}

async function uploadFiles(files: File[]) {
  if (!files.length) return
  uploadError.value = ''
  pendingUploads.value++
  for (const file of files) {
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      uploadError.value = t('widget.uploadTooLarge', { size: MAX_UPLOAD_MB })
      continue
    }
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await widgetFetch<{ key: string }>('/api/upload', { method: 'POST', body: form })
      attachments.value.push({ key: res.key, name: file.name })
    }
    catch (err) {
      // Same 401 contract as send(): park before the SDK rebuilds the frame.
      if ((err as { statusCode?: number })?.statusCode === 401) {
        parkForResume(draft.value, attachments.value, messages.value)
        emit('authRequired')
        break
      }
      uploadError.value = t('widget.uploadFailed')
    }
  }
  pendingUploads.value--
}

function scrollToBottom() {
  nextTick(() => { if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight })
}

// An expired session makes the SDK rebuild this frame, wiping everything held in
// memory. Parking in sessionStorage survives that rebuild — and only that: the
// archive is read once and dies with the tab, so a plain reload still starts
// clean rather than becoming the chat persistence the MVP skips.
const RESUME_KEY = 'feedlog:widget:resume'

function parkForResume(text: string, files: Attachment[], log: ChatMessage[]) {
  try {
    const owner = user.value?.email ?? ''
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({ owner, text, files, log, conversationId: conversationId.value }))
  }
  catch { /* storage unavailable — the draft is lost, nothing else breaks */ }
}

function resumeParked(): boolean {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY)
    if (!raw) return false
    sessionStorage.removeItem(RESUME_KEY)
    const saved = JSON.parse(raw) as { owner?: string, text?: string, files?: Attachment[], log?: ChatMessage[], conversationId?: string | null }
    // A rebuild that never completed leaves the archive for whoever signs in
    // next on this tab; a half-sent message goes back only to its author.
    if (saved.owner !== user.value?.email) return false
    draft.value = saved.text ?? ''
    attachments.value = saved.files ?? []
    if (saved.log?.length) {
      messages.value = saved.log
      // Restored together or not at all — an id without its log would send an
      // empty history for a conversation that already has one.
      conversationId.value = saved.conversationId ?? null
      return true
    }
  }
  catch { /* ignore malformed leftovers */ }
  return false
}

function toHistory() {
  return messages.value
    .filter(m => m.role === 'user' || m.type)
    .map(m => m.role === 'user'
      ? { role: 'user' as const, text: m.text }
      : { role: 'assistant' as const, text: m.text, type: m.type, ...(m.post ? { postTitle: m.post.title } : {}) })
}

function onEnterKey(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  void send()
}

async function send() {
  const text = draft.value.trim()
  const imageFiles = [...attachments.value]
  const images = imageFiles.map(a => a.key)
  if ((!text && !images.length) || sending.value || uploading.value) return
  const history = toHistory()
  messages.value.push({ role: 'user', text, images })
  draft.value = ''
  attachments.value = []
  uploadError.value = ''
  sending.value = true
  scrollToBottom()
  try {
    const res = await widgetFetch<{ conversationId: string, type: WidgetAiType, reply: string, post?: ChatMessage['post'] }>(
      '/api/widget/messages',
      { method: 'POST', body: JSON.stringify({ text, images, conversationId: conversationId.value, history }) },
    )
    conversationId.value = res.conversationId
    messages.value.push({ role: 'assistant', text: res.reply, type: res.type, post: res.post })
    emit('replied', res.conversationId)
    // A new post belongs in the list the moment it exists.
    if (res.post) emit('filed')
  }
  catch (e) {
    const statusCode = (e as { statusCode?: number })?.statusCode
    // Nothing was stored, so the bubble goes back to being unsent text.
    if (statusCode === 409) {
      messages.value.pop()
      fullCarry.value = { text, files: imageFiles }
    }
    // 401 means the SDK must re-exchange; anything else is a plain failure.
    else if (statusCode === 401) {
      // Park before signalling — the SDK rebuilds this frame in response, so
      // anything written after requestAuth() is lost. The bubble goes first: it
      // never reached the server, and replaying it would claim otherwise.
      messages.value.pop()
      parkForResume(text, imageFiles, messages.value)
      emit('authRequired')
    }
    else {
      messages.value.push({ role: 'assistant', text: t('widget.sendFailed') })
    }
  }
  finally {
    sending.value = false
    scrollToBottom()
  }
}

interface StoredMessage {
  role: string
  kind: string | null
  text: string
  images: string[]
  post: ChatMessage['post'] | null
}

// Re-sent as if freshly typed, so it takes the normal path into a new one.
async function carryOver() {
  const carried = fullCarry.value
  if (!carried) return
  fullCarry.value = null
  messages.value = []
  conversationId.value = null
  draft.value = carried.text
  attachments.value = carried.files
  await send()
}

// Kept alive: another conversation arrives as a prop change, never a re-mount.
async function syncToOpenId() {
  if (props.openId === conversationId.value && messages.value.length) return

  fullCarry.value = null

  if (!props.openId) {
    messages.value = [{ role: 'assistant', text: t('widget.greeting', { product: props.productName }) }]
    conversationId.value = null
    return
  }

  loadingThread.value = true
  try {
    const res = await widgetFetch<{ data: StoredMessage[] }>(`/api/widget/conversations/${props.openId}/messages`)
    messages.value = res.data.map(m => ({
      role: m.role === 'user' ? 'user' as const : 'assistant' as const,
      text: m.text,
      images: m.images,
      type: (m.kind ?? undefined) as WidgetAiType | undefined,
      post: m.post ?? undefined,
    }))
    conversationId.value = props.openId
  }
  catch {
    messages.value = [{ role: 'assistant', text: t('widget.loadFailed') }]
  }
  finally {
    loadingThread.value = false
    await nextTick()
    scrollToBottom()
  }
}

// A resumed draft brings its own conversation; the activate after this mount
// must not discard it.
let skipNextSync = false

onMounted(() => {
  if (resumeParked()) {
    skipNextSync = true
    return
  }
  void syncToOpenId()
})

onActivated(() => {
  if (skipNextSync) {
    skipNextSync = false
    return
  }
  void syncToOpenId()
})
</script>

<template>
  <div v-if="loadingThread" class="flex-1 grid place-items-center bg-background">
    <Icon name="lucide:loader-2" size="20" class="animate-spin text-muted-foreground" />
  </div>

  <div v-else ref="bodyEl" class="flex-1 overflow-y-auto bg-background p-3.5 space-y-2.5">
    <div v-for="(m, i) in messages" :key="i" class="flex" :class="m.role === 'user' ? 'justify-end' : 'justify-start'">
      <div :class="m.post ? 'max-w-[92%]' : 'max-w-[82%]'">
        <div
          class="px-3 py-2.5 rounded-lg text-[13.5px] leading-normal"
          :class="m.role === 'user'
            ? 'bg-primary text-primary-foreground rounded-br-sm'
            : 'bg-card border border-border rounded-bl-sm'"
        >
          <WidgetEmbedMessageText v-if="m.text" :text="m.text" />
          <div v-if="m.images?.length" class="flex flex-wrap gap-1.5" :class="m.text ? 'mt-2' : ''">
            <img
              v-for="k in m.images"
              :key="k"
              :src="resolveAttachmentUrl(k)!"
              alt=""
              class="w-16 h-16 rounded-lg object-cover border border-black/10"
            >
          </div>
          <WidgetEmbedFeedbackCard
            v-if="m.post"
            :title="m.post.title"
            :board="m.post.board"
            :status="m.post.status"
            @open="protocol.navigateToFeedback(m.post!.slug)"
          />
        </div>
      </div>
    </div>

    <p v-if="fullCarry" class="mx-auto max-w-[92%] py-1 text-center text-[11px] leading-4 text-muted-foreground">
      {{ t('widget.conversationFullNote') }}
    </p>

    <div v-if="sending" class="flex justify-start">
      <div class="px-3.5 py-2.5 rounded-lg rounded-bl-sm bg-card border border-border text-xs text-muted-foreground flex items-center gap-1.5">
        <span class="flex items-center gap-1" aria-hidden="true">
          <span v-for="n in 3" :key="n" class="w-1 h-1 rounded-full bg-current opacity-40 typing-dot" :style="{ animationDelay: `${(n - 1) * 0.16}s` }" />
        </span>
        {{ t('widget.thinking') }}
      </div>
    </div>
  </div>

  <div v-if="fullCarry" class="p-3 border-t border-border bg-card shrink-0">
    <div class="rounded-xl border border-border bg-background p-3">
      <p class="text-xs font-semibold leading-[16.5px]">{{ t('widget.conversationFullTitle') }}</p>
      <p class="mt-2 px-2.5 py-2 rounded-lg bg-secondary text-xs leading-[17px] line-clamp-2">{{ fullCarry.text }}</p>
      <button
        class="mt-2.5 w-full h-9 rounded-full bg-primary text-primary-foreground text-[13px] font-bold inline-flex items-center justify-center gap-2 hover:brightness-105 transition-all"
        @click="carryOver"
      >
        {{ t('widget.startNewConversation') }}
        <Icon name="lucide:send-horizontal" size="15" />
      </button>
    </div>
  </div>

  <div v-else class="px-3 py-2.5 bg-card shrink-0">
    <p v-if="uploadError" class="mb-2 flex items-start gap-1.5 text-[11px] text-destructive">
      <Icon name="lucide:alert-circle" size="13" class="shrink-0 mt-px" />
      <span class="flex-1">{{ uploadError }}</span>
      <button
        class="shrink-0 hover:opacity-70 transition-opacity"
        :aria-label="t('widget.close')"
        @click="uploadError = ''"
      >
        <Icon name="lucide:x" size="12" />
      </button>
    </p>

    <!-- Staged attachments: already uploaded, waiting to ride along with the message. -->
    <div v-if="attachments.length || uploading" class="flex flex-wrap gap-1.5 mb-2">
      <div
        v-for="(a, i) in attachments"
        :key="a.key"
        class="relative h-12 w-16 rounded-md overflow-hidden border border-border group"
      >
        <img :src="resolveAttachmentUrl(a.key)!" :alt="a.name" class="w-full h-full object-cover">
        <button
          class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white"
          :aria-label="t('widget.cancel')"
          @click="attachments.splice(i, 1)"
        >
          <Icon name="lucide:x" size="14" />
        </button>
      </div>
      <div v-if="uploading" class="h-12 w-16 rounded-md border border-border grid place-items-center">
        <Icon name="lucide:loader-2" size="14" class="animate-spin text-muted-foreground" />
      </div>
    </div>

    <!-- Controls sit on their own row so the textarea can grow into the card
         instead of stretching the buttons beside it. -->
    <div class="rounded-md border border-border bg-card transition-shadow focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/15">
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        @change="onFilePicked"
      >
      <textarea
        ref="draftEl"
        v-model="draft"
        rows="1"
        :placeholder="t('widget.placeholder')"
        class="w-full min-h-12 max-h-[120px] px-3 py-2 bg-transparent text-[13.5px] leading-normal resize-none focus:outline-none no-scrollbar"
        @keydown.enter.exact="onEnterKey"
        @paste="onPaste"
      />
      <div class="flex items-center justify-between px-1.5 py-1">
        <button
          :disabled="uploading || sending"
          class="h-6.5 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          :aria-label="t('widget.attachImage')"
          @click="fileInput?.click()"
        >
          <Icon name="lucide:image" size="15" />
        </button>
        <button
          :disabled="(!draft.trim() && !attachments.length) || sending || uploading"
          class="px-3.5 py-1.5 rounded-md bg-primary text-primary-foreground text-[12.5px] font-heading font-semibold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          @click="send"
        >
          {{ t('widget.send') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The composer scrolls past max-h-[120px], but a scrollbar inside a 400px panel
   is more noise than affordance. */
.no-scrollbar {
  scrollbar-width: none;
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}

.typing-dot {
  animation: typing 1.2s ease-in-out infinite;
}

@keyframes typing {
  0%, 60%, 100% { opacity: 0.25; }
  30% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .typing-dot {
    animation: none;
  }
}
</style>
