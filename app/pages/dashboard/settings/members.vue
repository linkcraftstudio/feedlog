<script setup lang="ts">
import { authClient } from '~/lib/auth-client'

// /dashboard/settings/members — list members + pending invitations.
// Backed by better-auth organization plugin's listMembers / listInvitations
// + invite / removeMember / updateMemberRole / cancelInvitation.

definePageMeta({ layout: 'dashboard', middleware: ['admin'] })

const ctx = useOrgContext()
const { data: session } = useAuthSession()
const orgId = computed(() => ctx.value.orgId)
const myUserId = computed(() => session.value?.user?.id)
const canManage = computed(() => ctx.value.role === 'owner' || ctx.value.role === 'manager')
const canPromoteToOwner = computed(() => ctx.value.role === 'owner')

type Role = 'owner' | 'manager' | 'contributor'

interface MemberView {
  id: string
  userId: string
  role: Role
  createdAt?: string
  user: { name: string; email: string; image: string | null }
}
interface InvitationView {
  id: string
  email: string
  role: Role
  status: string
  expiresAt: string | null
  inviterId: string
}

const members = ref<MemberView[]>([])
const invitations = ref<InvitationView[]>([])
const loading = ref(true)

async function refresh() {
  loading.value = true
  try {
    const [memRes, invRes] = await Promise.all([
      authClient.organization.listMembers({ query: { organizationId: orgId.value, limit: 200 } }),
      authClient.organization.listInvitations({ query: { organizationId: orgId.value } }),
    ])
    members.value = ((memRes as { data?: { members?: MemberView[] } }).data?.members ?? []) as MemberView[]
    invitations.value = (((invRes as { data?: InvitationView[] }).data) ?? [])
      .filter(i => i.status === 'pending')
  } finally {
    loading.value = false
  }
}
// Defer to onMounted: authClient.organization.* hits /api/... with a
// relative URL via better-fetch, which Node's fetch can't parse during
// SSR. Loading is fine as a post-mount fetch — the table renders in
// `loading` state briefly then populates.
onMounted(() => { void refresh() })

const ownerCount = computed(() => members.value.filter(m => m.role === 'owner').length)

const roleOptions: { key: Role; label: string; icon: string; desc: string }[] = [
  { key: 'contributor', label: 'Contributor', icon: 'lucide:user', desc: 'View feedback from inside the dashboard and join discussions.' },
  { key: 'manager', label: 'Manager', icon: 'lucide:shield', desc: 'Manage feedback, changelogs, and the roadmap.' },
  { key: 'owner', label: 'Owner', icon: 'lucide:crown', desc: 'Full access. Can manage members, settings, and ownership.' },
]
const roleIcon = (role: string) => roleOptions.find(r => r.key === role)?.icon ?? 'lucide:user'
// Hide 'owner' from non-owners — promoting to owner is owner-only.
const availableRoles = computed(() => canPromoteToOwner.value ? roleOptions : roleOptions.filter(r => r.key !== 'owner'))

// Invite modal
const showInvite = ref(false)
const inviteEmails = ref('')
const inviteRole = ref<Role>('contributor')
const inviting = ref(false)

// Whether an outbound email provider (Resend) is configured. When false, the
// invite is still created but no email is sent — admin must copy the link
// manually. Surfaced as a banner inside the modal so this isn't surprising.
const { data: authCfg } = await useFetch<{ emailProvider?: boolean }>('/api/auth-config', {
  key: 'auth-config',
  default: () => ({ emailProvider: false }),
})
const emailConfigured = computed(() => !!authCfg.value?.emailProvider)
const currentInviteRole = computed(() => roleOptions.find(r => r.key === inviteRole.value)!)

async function sendInvite() {
  const emails = inviteEmails.value.split(/[,;\n\s]+/).map(s => s.trim()).filter(Boolean)
  if (emails.length === 0) return
  inviting.value = true
  try {
    for (const email of emails) {
      await authClient.organization.inviteMember({
        organizationId: orgId.value,
        email,
        role: inviteRole.value,
      })
    }
    showInvite.value = false
    inviteEmails.value = ''
    inviteRole.value = 'contributor'
    await refresh()
  } finally {
    inviting.value = false
  }
}

async function cancelInvitation(id: string) {
  await authClient.organization.cancelInvitation({ invitationId: id })
  await refresh()
}

async function onRoleChange(member: MemberView, role: Role) {
  if (role === member.role) return
  if (member.role === 'owner' && role !== 'owner' && ownerCount.value <= 1) return
  await authClient.organization.updateMemberRole({
    organizationId: orgId.value,
    memberId: member.id,
    role,
  })
  await refresh()
}

async function removeMember(member: MemberView) {
  if (member.role === 'owner' && ownerCount.value <= 1) return
  await authClient.organization.removeMember({
    organizationId: orgId.value,
    memberIdOrEmail: member.id,
  })
  await refresh()
}

function copyInviteLink(invitationId: string) {
  const url = `${window.location.origin}/invite?id=${invitationId}`
  navigator.clipboard?.writeText(url)
}

function formatExpiresIn(iso: string | null): string {
  if (!iso) return ''
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return 'expired'
  const days = Math.floor(diff / (24 * 60 * 60 * 1000))
  if (days >= 1) return `${days}d`
  const hours = Math.floor(diff / (60 * 60 * 1000))
  if (hours >= 1) return `${hours}h`
  const mins = Math.max(1, Math.floor(diff / (60 * 1000)))
  return `${mins}m`
}

function initials(name: string | undefined): string {
  return (name ?? '').slice(0, 2).toUpperCase()
}
</script>

<template>
  <div class="flex flex-col h-full">
    <header class="h-16 px-6 border-b border-border flex items-center justify-between shrink-0 bg-card">
      <div>
        <h2 class="font-heading text-lg font-bold">Members</h2>
        <p class="text-xs text-muted-foreground">Manage who can access this workspace</p>
      </div>
      <button
        v-if="canManage"
        class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all flex items-center gap-2"
        @click="showInvite = true"
      >
        <Icon name="lucide:user-plus-2" size="14" />
        Invite
      </button>
    </header>

    <div class="flex-1 overflow-y-auto">
      <div class="max-w-4xl mx-auto px-6 py-8 space-y-8">
        <template v-if="loading">
          <p class="text-sm text-muted-foreground">Loading…</p>
        </template>

        <template v-else>
          <!-- Pending invitations -->
          <section v-if="invitations.length" class="rounded-xl border border-border bg-card overflow-hidden">
            <div class="px-5 py-3 border-b border-border">
              <h3 class="font-heading font-bold text-sm">Pending invitations</h3>
            </div>
            <ul class="divide-y divide-border">
              <li v-for="inv in invitations" :key="inv.id" class="px-5 py-3 flex items-center gap-3">
                <div class="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <Icon name="lucide:mail" size="14" class="text-muted-foreground" />
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-semibold truncate">{{ inv.email }}</p>
                  <p class="text-[11px] text-muted-foreground truncate">
                    Invited as <span class="font-semibold capitalize">{{ inv.role }}</span>
                    <template v-if="inv.expiresAt"> · expires in {{ formatExpiresIn(inv.expiresAt) }}</template>
                  </p>
                </div>
                <DropdownMenu v-if="canManage">
                  <DropdownMenuTrigger as-child>
                    <button class="w-8 h-8 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground">
                      <Icon name="lucide:more-horizontal" size="14" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" class="w-[180px]">
                    <DropdownMenuItem @click="copyInviteLink(inv.id)">
                      <Icon name="lucide:link" size="13" class="mr-2" />
                      Copy invitation link
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem class="text-red-600" @click="cancelInvitation(inv.id)">
                      <Icon name="lucide:x" size="13" class="mr-2" />
                      Revoke
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            </ul>
          </section>

          <!-- Members table -->
          <section class="rounded-xl border border-border bg-card overflow-hidden">
            <div class="px-5 py-3 border-b border-border flex items-center justify-between">
              <h3 class="font-heading font-bold text-sm">Members</h3>
              <span class="text-[11px] text-muted-foreground">{{ members.length }} total</span>
            </div>
            <ul class="divide-y divide-border">
              <li v-for="m in members" :key="m.id" class="px-5 py-3 flex items-center gap-3">
                <div class="w-9 h-9 rounded-full overflow-hidden bg-muted shrink-0 flex items-center justify-center">
                  <img
                    v-if="m.user.image"
                    :src="m.user.image"
                    :alt="m.user.name"
                    class="w-full h-full object-cover"
                    referrerpolicy="no-referrer"
                  >
                  <span v-else class="text-foreground text-xs font-bold">{{ initials(m.user.name) }}</span>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <p class="text-sm font-bold truncate">{{ m.user.name }}</p>
                    <span v-if="m.userId === myUserId" class="text-[10px] font-bold uppercase tracking-wider bg-muted text-muted-foreground px-1.5 py-0.5 rounded">You</span>
                  </div>
                  <p class="text-[11px] text-muted-foreground truncate">{{ m.user.email }}</p>
                </div>

                <!-- Role: inline Select (read-only label for self / when can't manage) -->
                <Select
                  v-if="canManage && m.userId !== myUserId"
                  :model-value="m.role"
                  :disabled="m.role === 'owner' && ownerCount === 1"
                  @update:model-value="(v) => onRoleChange(m, v as Role)"
                >
                  <SelectTrigger class="h-8 w-auto gap-1.5 px-2.5 text-xs font-semibold capitalize">
                    <span class="flex items-center gap-1.5">
                      <Icon :name="roleIcon(m.role)" size="12" class="text-muted-foreground" />
                      <span>{{ m.role }}</span>
                    </span>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem v-for="r in availableRoles" :key="r.key" :value="r.key" class="py-2.5">
                      <div class="flex items-start gap-2.5">
                        <Icon :name="r.icon" size="14" class="mt-0.5 shrink-0 opacity-70" />
                        <div class="min-w-0">
                          <p class="text-sm font-semibold leading-tight">{{ r.label }}</p>
                          <p class="text-[11px] leading-snug mt-0.5 opacity-70">{{ r.desc }}</p>
                        </div>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <span v-else class="inline-flex items-center gap-1.5 h-8 px-2.5 text-xs font-semibold capitalize text-muted-foreground">
                  <Icon :name="roleIcon(m.role)" size="12" />
                  {{ m.role }}
                </span>

                <!-- More -->
                <DropdownMenu v-if="canManage && m.userId !== myUserId">
                  <DropdownMenuTrigger as-child>
                    <button class="w-8 h-8 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground">
                      <Icon name="lucide:more-horizontal" size="14" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" class="w-[180px]">
                    <DropdownMenuItem
                      class="text-red-600"
                      :disabled="m.role === 'owner' && ownerCount <= 1"
                      @click="removeMember(m)"
                    >
                      <Icon name="lucide:user-x" size="13" class="mr-2" />
                      Remove from org
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            </ul>
          </section>

          <!-- Footnote about last owner safeguard -->
          <p class="text-[11px] text-muted-foreground leading-relaxed">
            <Icon name="lucide:shield-check" size="11" class="inline mr-1" />
            The last owner of a workspace cannot be demoted or removed. Transfer ownership first.
          </p>
        </template>
      </div>
    </div>

    <Dialog v-model:open="showInvite">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="font-heading">Invite members</DialogTitle>
          <DialogDescription class="text-sm">
            Send an email invitation. Invitations expire in 7 days.
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <!-- Email-not-configured banner -->
          <div v-if="!emailConfigured" class="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
            <Icon name="lucide:mail-x" size="14" class="mt-0.5 shrink-0" />
            <div>
              <p class="font-bold">Email not configured</p>
              <p class="mt-0.5 leading-relaxed">No Resend API key set. The invitation will be created but no email is sent — copy the link from the list and share it manually.</p>
            </div>
          </div>

          <!-- Emails input -->
          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Email addresses</label>
            <textarea
              v-model="inviteEmails"
              rows="2"
              placeholder="alice@acme.com, bob@acme.com"
              class="mt-2 w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary transition-colors resize-none"
            />
            <p class="text-[11px] text-muted-foreground mt-1">Comma or newline separated</p>
          </div>

          <!-- Role -->
          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Role</label>
            <Select v-model="inviteRole">
              <SelectTrigger class="mt-2 w-full h-10 text-sm">
                <SelectValue>
                  <span class="flex items-center gap-2">
                    <Icon :name="currentInviteRole.icon" size="14" class="text-muted-foreground" />
                    <span class="font-semibold">{{ currentInviteRole.label }}</span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="r in availableRoles" :key="r.key" :value="r.key" class="py-2.5">
                  <div class="flex items-start gap-2.5">
                    <Icon :name="r.icon" size="14" class="mt-0.5 shrink-0 opacity-70" />
                    <div class="min-w-0">
                      <p class="text-sm font-semibold leading-tight">{{ r.label }}</p>
                      <p class="text-[11px] leading-snug mt-0.5 opacity-70">{{ r.desc }}</p>
                    </div>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">{{ currentInviteRole.desc }}</p>

            <!-- In-context warning when Owner is selected -->
            <div v-if="inviteRole === 'owner'" class="mt-3 flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-900 leading-relaxed">
              <Icon name="lucide:alert-triangle" size="13" class="mt-0.5 shrink-0 text-amber-600" />
              <span>Owners have full administrative access — managing members, settings, and ownership. Only invite people you fully trust.</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <button class="h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors" @click="showInvite = false">
            Cancel
          </button>
          <button
            :disabled="!inviteEmails.trim() || inviting"
            class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            @click="sendInvite"
          >
            {{ inviting ? (emailConfigured ? 'Sending…' : 'Creating…') : (emailConfigured ? 'Send invitations' : 'Create invitations') }}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
