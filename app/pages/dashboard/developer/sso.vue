<script setup lang="ts">
import { toast } from 'vue-sonner'
import type { SsoSecret } from '~/composables/useSsoSecrets'
import { SSO_SECRET_LIMIT } from '~~/shared/constants/sso'

// /dashboard/settings/sso — manage product-SSO signing secrets + integration
// guide. Owner-only (the API enforces it too); other staff see a notice.

definePageMeta({ layout: 'dashboard', middleware: ['admin'] })

const ctx = useOrgContext()
const isOwner = computed(() => ctx.value.role === 'owner')

const { secrets, loading, refresh, create, update, remove } = useSsoSecrets()

const view = ref<'secrets' | 'guide'>('secrets')
const used = computed(() => secrets.value.length)
const canCreate = computed(() => used.value < SSO_SECRET_LIMIT)

// Defer to onMounted: the list endpoint needs the session cookie, simplest to
// fetch client-side after mount (mirrors the Members page).
onMounted(() => { if (isOwner.value) void refresh() })

// Create + rename share one dialog (SsoSecretDialog). dialogMode picks the copy;
// renameTarget is set only in rename mode.
const dialogOpen = ref(false)
const dialogMode = ref<'create' | 'rename'>('create')
const renameTarget = ref<SsoSecret | null>(null)
const justCreatedId = ref<string | null>(null)

function openCreate() {
  dialogMode.value = 'create'
  renameTarget.value = null
  dialogOpen.value = true
}
function openRename(s: SsoSecret) {
  dialogMode.value = 'rename'
  renameTarget.value = s
  dialogOpen.value = true
}

async function onDialogSubmit(payload: { label: string }) {
  const mode = dialogMode.value
  const target = renameTarget.value
  dialogOpen.value = false
  try {
    if (mode === 'create') {
      const s = await create(payload.label)
      justCreatedId.value = s.id
      setTimeout(() => { if (justCreatedId.value === s.id) justCreatedId.value = null }, 6000)
    }
    else if (target) {
      await update(target.id, { label: payload.label })
    }
  }
  catch (e) {
    toast.error((e as { data?: { message?: string } })?.data?.message
      || (mode === 'create' ? 'Failed to create secret' : 'Failed to rename secret'))
  }
}

async function onToggle(s: SsoSecret) {
  try {
    await update(s.id, { enabled: !s.enabled })
  }
  catch {
    toast.error('Failed to update secret')
  }
}

// Delete (page-level confirm). Keep the target in its own ref, separate from the
// dialog's open flag — reka-ui's AlertDialogAction closes the dialog on click,
// and if open-state and target shared one ref the close would wipe the target
// before confirmDelete reads it (DELETE then silently never fires).
const deleteTarget = ref<SsoSecret | null>(null)
const showDelete = ref(false)
function askDelete(s: SsoSecret) {
  deleteTarget.value = s
  showDelete.value = true
}
async function confirmDelete() {
  const target = deleteTarget.value
  showDelete.value = false
  if (!target) return
  try {
    await remove(target.id)
  }
  catch {
    toast.error('Failed to delete secret')
  }
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <header class="h-16 px-6 border-b border-border flex items-center justify-between shrink-0 bg-card">
      <div>
        <h2 class="font-heading text-lg font-bold">Single Sign-On</h2>
        <p class="text-xs text-muted-foreground">Let users from your product sign in without a second login</p>
      </div>
      <button
        v-if="isOwner && view === 'secrets'"
        :disabled="!canCreate"
        class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-2"
        :title="canCreate ? '' : `Limit of ${SSO_SECRET_LIMIT} secrets reached`"
        @click="openCreate"
      >
        <Icon name="lucide:plus" size="14" />
        Create secret
      </button>
    </header>

    <!-- Sub-nav (segmented) -->
    <div class="px-6 pt-4 border-b border-border bg-card shrink-0">
      <div class="flex gap-6">
        <button
          v-for="tab in [{ k: 'secrets', label: 'Signing secrets' }, { k: 'guide', label: 'Integration guide' }]"
          :key="tab.k"
          class="pb-3 -mb-px text-sm font-semibold border-b-2 transition-colors"
          :class="view === tab.k ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="view = tab.k as 'secrets' | 'guide'"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto">
      <div class="max-w-3xl mx-auto px-6 py-8">
        <!-- Owner gate -->
        <div v-if="!isOwner" class="rounded-xl border border-border bg-card px-6 py-14 flex flex-col items-center text-center">
          <div class="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-3">
            <Icon name="lucide:lock" size="22" class="text-muted-foreground" />
          </div>
          <p class="font-heading font-bold text-sm">Owners only</p>
          <p class="text-xs text-muted-foreground mt-1 max-w-xs leading-relaxed">
            Only workspace owners can manage SSO signing secrets. Ask an owner if you need access.
          </p>
        </div>

        <!-- Secrets -->
        <template v-else-if="view === 'secrets'">
          <section class="rounded-xl border border-border bg-card overflow-hidden">
            <div class="px-5 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h3 class="font-heading font-bold text-sm">Signing secrets</h3>
                <p class="text-[11px] text-muted-foreground mt-0.5">Shared JWT secrets your backend uses to sign SSO tokens.</p>
              </div>
              <span class="text-[11px] font-semibold text-muted-foreground tabular-nums">{{ used }} of {{ SSO_SECRET_LIMIT }} used</span>
            </div>

            <!-- Loading -->
            <div v-if="loading" class="px-6 py-14 text-center text-sm text-muted-foreground">Loading…</div>

            <!-- Empty state -->
            <div v-else-if="!secrets.length" class="px-6 py-14 flex flex-col items-center text-center">
              <div class="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-3">
                <Icon name="lucide:key-round" size="22" class="text-primary" />
              </div>
              <p class="font-heading font-bold text-sm">No signing secrets yet</p>
              <p class="text-xs text-muted-foreground mt-1 max-w-xs leading-relaxed">
                Create a secret, then use it on your backend to sign SSO tokens for your users.
              </p>
              <button
                class="mt-4 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all flex items-center gap-2"
                @click="openCreate"
              >
                <Icon name="lucide:plus" size="14" />
                Create secret
              </button>
            </div>

            <!-- List -->
            <div v-else class="divide-y divide-border">
              <SsoSecretRow
                v-for="s in secrets"
                :key="s.id"
                :secret="s"
                :just-created="s.id === justCreatedId"
                @toggle="onToggle(s)"
                @rename="openRename(s)"
                @delete="askDelete(s)"
              />
            </div>
          </section>

          <!-- Rotation hint -->
          <p class="text-[11px] text-muted-foreground leading-relaxed mt-4">
            <Icon name="lucide:refresh-cw" size="11" class="inline mr-1" />
            <span class="font-semibold">Rotating a secret:</span> create a new one, switch your product to it, then
            <span class="font-semibold">disable</span> the old one (re-enable if something breaks). Delete it once you're sure.
            Tokens are verified against every enabled secret.
          </p>
        </template>

        <!-- Integration guide -->
        <SsoIntegrationGuide v-else />
      </div>
    </div>

    <SsoSecretDialog
      v-model:open="dialogOpen"
      :mode="dialogMode"
      :initial-label="renameTarget?.label ?? ''"
      @submit="onDialogSubmit"
    />

    <!-- Delete confirmation -->
    <AlertDialog v-model:open="showDelete">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle class="font-heading">Delete this secret?</AlertDialogTitle>
          <AlertDialogDescription>
            <span class="font-semibold text-foreground">{{ deleteTarget?.label || 'Untitled' }}</span> will be permanently deleted.
            Any tokens signed with it stop working immediately. This can't be undone — if you only want to pause it, disable it instead.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction class="bg-red-600 hover:bg-red-700 text-white" @click="confirmDelete">
            Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
