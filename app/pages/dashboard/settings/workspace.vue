<script setup lang="ts">
import { authClient } from '~/lib/auth-client'

// /dashboard/settings/workspace — single-tenant workspace settings.
// Owners can edit the workspace name (surfaced in invitation emails as the
// "Join {name} on FeedLog" greeting). No slug, no delete — the open-source
// install has exactly one workspace.

definePageMeta({ layout: 'dashboard', middleware: ['admin'] })

const ctx = useOrgContext()
const orgId = computed(() => ctx.value.orgId)
const isOwner = computed(() => ctx.value.role === 'owner')

interface OrgRow {
  id: string
  name: string
  slug: string
  logo: string | null
  metadata: string | null
}

const org = ref<OrgRow | null>(null)
const loading = ref(true)
const form = reactive({ name: '' })

async function loadOrg() {
  loading.value = true
  try {
    const res = await authClient.organization.getFullOrganization({ query: { organizationId: orgId.value } })
    org.value = (res as { data?: OrgRow }).data ?? null
    if (org.value) form.name = org.value.name
  } finally {
    loading.value = false
  }
}
// Defer to onMounted — same reason as members.vue (authClient hits
// /api/... with a relative URL; Node fetch can't parse it during SSR).
onMounted(() => { void loadOrg() })

const dirty = computed(() => org.value && form.name !== org.value.name)
const canSave = computed(() => dirty.value && form.name.trim().length > 0 && isOwner.value)

const saving = ref(false)
async function save() {
  if (!org.value || !canSave.value) return
  saving.value = true
  try {
    await authClient.organization.update({
      organizationId: org.value.id,
      data: { name: form.name.trim() },
    })
    await loadOrg()
  } finally {
    saving.value = false
  }
}

function reset() {
  if (org.value) form.name = org.value.name
}
</script>

<template>
  <div class="flex flex-col h-full">
    <header class="h-16 px-6 border-b border-border flex items-center shrink-0 bg-card">
      <div>
        <h2 class="font-heading text-lg font-bold">Workspace</h2>
        <p class="text-xs text-muted-foreground">Your workspace's identity</p>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto">
      <div class="max-w-2xl mx-auto px-6 py-8 space-y-8">
        <template v-if="loading">
          <p class="text-sm text-muted-foreground">Loading…</p>
        </template>

        <template v-else-if="org">
          <section class="rounded-xl border border-border bg-card overflow-hidden">
            <div class="px-6 py-5 border-b border-border">
              <h3 class="font-heading font-bold text-sm">General</h3>
              <p class="text-xs text-muted-foreground mt-0.5">How your workspace appears to members and in invitation emails.</p>
            </div>
            <div class="px-6 py-6 space-y-6">
              <div>
                <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Workspace name</label>
                <input
                  v-model="form.name"
                  type="text"
                  :disabled="!isOwner"
                  placeholder="Acme Corp"
                  class="mt-2 w-full h-11 px-3.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary transition-colors disabled:opacity-60"
                >
                <p class="text-[11px] text-muted-foreground mt-1.5">Your team or company name. Shown to members and in invitation emails.</p>
              </div>
            </div>
          </section>
        </template>
      </div>
    </div>

    <Transition
      enter-from-class="translate-y-full"
      leave-to-class="translate-y-full"
      enter-active-class="transition-transform duration-200"
      leave-active-class="transition-transform duration-200"
    >
      <div v-if="dirty" class="border-t border-border bg-card px-6 py-3 flex items-center justify-between shrink-0">
        <p class="text-xs text-muted-foreground flex items-center gap-1.5">
          <Icon name="lucide:dot" size="20" class="text-amber-500 -mr-1" />
          You have unsaved changes
        </p>
        <div class="flex items-center gap-2">
          <button class="h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors" @click="reset">
            Reset
          </button>
          <button
            :disabled="!canSave || saving"
            class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            @click="save"
          >
            {{ saving ? 'Saving…' : 'Save changes' }}
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
