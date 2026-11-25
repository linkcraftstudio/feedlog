<script setup lang="ts">
import { toast } from 'vue-sonner'
import { authClient } from '~/lib/auth-client'

// /dashboard/members — list members + pending invitations.
// Backed by better-auth organization plugin's listMembers / listInvitations
// + invite / removeMember / updateMemberRole / cancelInvitation.

definePageMeta({ layout: 'dashboard', middleware: ['admin'] })

const ctx = useOrgContext()
const { data: session } = useAuthSession()
const orgId = computed(() => ctx.value.orgId)
const myUserId = computed(() => session.value?.user?.id)
// A suspended member keeps read access to this page but manages nothing.
const canManage = computed(() => !ctx.value.suspended && (ctx.value.role === 'owner' || ctx.value.role === 'manager'))
const canPromoteToOwner = computed(() => ctx.value.role === 'owner')
const { t } = useI18n()

type Role = 'owner' | 'manager' | 'contributor'

interface MemberView {
  id: string
  userId: string
  role: Role
  createdAt?: string
  suspendedAt?: string | null
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

const nuxtApp = useNuxtApp()
// `changed`: called after this page changed membership, as opposed to the first load.
async function refresh(changed = true) {
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
  if (changed) void nuxtApp.callHook('feedlog:members:changed')
}
// Defer to onMounted: authClient.organization.* hits /api/... with a
// relative URL via better-fetch, which Node's fetch can't parse during
// SSR. Loading is fine as a post-mount fetch — the table renders in
// `loading` state briefly then populates.
onMounted(() => { void refresh(false) })

const ownerCount = computed(() => members.value.filter(m => m.role === 'owner').length)
const suspendedCount = computed(() => members.value.filter(m => m.suspendedAt).length)

const roleOptions = computed<{ key: Role; label: string; icon: string; desc: string }[]>(() => [
  { key: 'contributor', label: t('settings.members.roles.contributor.label'), icon: 'lucide:user', desc: t('settings.members.roles.contributor.desc') },
  { key: 'manager', label: t('settings.members.roles.manager.label'), icon: 'lucide:shield', desc: t('settings.members.roles.manager.desc') },
  { key: 'owner', label: t('settings.members.roles.owner.label'), icon: 'lucide:crown', desc: t('settings.members.roles.owner.desc') },
])
const roleIcon = (role: string) => roleOptions.value.find(r => r.key === role)?.icon ?? 'lucide:user'
const roleLabel = (role: string) => roleOptions.value.find(r => r.key === role)?.label ?? role
// Hide 'owner' from non-owners — promoting to owner is owner-only.
const availableRoles = computed(() => canPromoteToOwner.value ? roleOptions.value : roleOptions.value.filter(r => r.key !== 'owner'))

// Invite modal
const showInvite = ref(false)
const inviteEmails = ref('')
const inviteRole = ref<Role>('contributor')
const inviting = ref(false)
const INVITE_ERRORS_SHOWN_BY_HOOK = new Set(['seat_limit_reached', 'feature_not_in_plan', 'member_suspended', 'PERMISSION_DENIED', 'LOCAL_AUTH_REQUIRED'])

// Buying a seat leaves the page and returns to /dashboard/members?invite=1;
// the unsent invitation survives that trip in sessionStorage.
const INVITE_DRAFT_KEY = 'feedlog.members.inviteDraft'
function saveInviteDraft() {
  try { sessionStorage.setItem(INVITE_DRAFT_KEY, JSON.stringify({ orgId: orgId.value, emails: inviteEmails.value, role: inviteRole.value })) }
  catch { /* The draft is a convenience; the dialog still opens empty. */ }
}
function clearInviteDraft() {
  try { sessionStorage.removeItem(INVITE_DRAFT_KEY) }
  catch { /* Nothing stored. */ }
}
function restoreInviteDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(INVITE_DRAFT_KEY) ?? 'null') as { orgId?: string; emails?: string; role?: Role } | null
    if (draft?.orgId !== orgId.value) return
    inviteEmails.value = draft.emails ?? ''
    if (draft.role && availableRoles.value.some(r => r.key === draft.role)) inviteRole.value = draft.role
  }
  catch { /* Unreadable draft: start empty. */ }
}
const route = useRoute()
const router = useRouter()
onMounted(() => {
  if (route.query.invite !== '1') return
  const { invite: _invite, ...query } = route.query
  void router.replace({ query })
  if (!canManage.value) return
  restoreInviteDraft()
  showInvite.value = true
})

// Whether an outbound email provider (Resend) is configured. When false, the
// invite is still created but no email is sent — admin must copy the link
// manually. Surfaced as a banner inside the modal so this isn't surprising.
const { data: authCfg } = await useFetch<{ emailProvider?: boolean }>('/api/auth-config', {
  key: 'auth-config',
  default: () => ({ emailProvider: false }),
})
const emailConfigured = computed(() => !!authCfg.value?.emailProvider)
const currentInviteRole = computed(() => roleOptions.value.find(r => r.key === inviteRole.value)!)

async function sendInvite() {
  const emails = inviteEmails.value.split(/[,;\n\s]+/).map(s => s.trim()).filter(Boolean)
  if (emails.length === 0) return
  inviting.value = true
  try {
    for (const [index, email] of emails.entries()) {
      const { error } = await authClient.organization.inviteMember({
        organizationId: orgId.value,
        email,
        role: inviteRole.value,
      })
      // The auth client reports refusals instead of throwing. Its error hook
      // already shows coded refusals (e.g. no free seat) and 403s; anything else
      // is shown here. Keep only the addresses not yet invited, so a retry does
      // not repeat the ones that went through.
      if (error) {
        if (!INVITE_ERRORS_SHOWN_BY_HOOK.has(error.code ?? '') && error.status !== 403) {
          const key = error.code === 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION' ? 'alreadyMember'
            : error.code === 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION' ? 'alreadyInvited'
              : 'inviteFailed'
          toast.error(t(`settings.members.inviteErrors.${key}`, { email }), { description: key === 'inviteFailed' ? error.message : undefined })
        }
        inviteEmails.value = emails.slice(index).join('\n')
        if (error.code === 'seat_limit_reached') saveInviteDraft()
        await refresh()
        return
      }
    }
    clearInviteDraft()
    showInvite.value = false
    inviteEmails.value = ''
    inviteRole.value = 'contributor'
    await refresh()
    toast.success(emails.length > 1 ? t('settings.members.invitationsCreated', { count: emails.length }) : t('settings.members.invitationCreated'), {
      description: emailConfigured.value
        ? t('settings.members.inviteToastEmailOn')
        : t('settings.members.inviteToastEmailOff'),
    })
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

const activeOwnerCount = computed(() => members.value.filter(m => m.role === 'owner' && !m.suspendedAt).length)
// Mirrors the server rules so the menu never offers a refused suspension.
const canSuspend = (member: MemberView) => member.role !== 'owner' || (canPromoteToOwner.value && activeOwnerCount.value > 1)

const activating = ref<string | null>(null)
async function setSuspended(member: MemberView, suspended: boolean) {
  activating.value = member.id
  try {
    await useApiFetch(`/api/admin/members/${member.id}/${suspended ? 'suspend' : 'activate'}`, { method: 'POST' })
    toast.success(t(suspended ? 'settings.members.suspendedToast' : 'settings.members.activated'))
    await refresh()
  }
  catch {
    // useApiFetch has shown the refusal (seat limit, permission).
  }
  finally {
    activating.value = null
  }
}
const activateMember = (member: MemberView) => setSuspended(member, false)

function copyInviteLink(invitationId: string) {
  const url = `${window.location.origin}/invite?id=${invitationId}`
  navigator.clipboard?.writeText(url)
}

function formatExpiresIn(iso: string | null): string {
  if (!iso) return ''
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return t('settings.members.expired')
  const days = Math.floor(diff / (24 * 60 * 60 * 1000))
  if (days >= 1) return `${days}d`
  const hours = Math.floor(diff / (60 * 60 * 1000))
  if (hours >= 1) return `${hours}h`
  const mins = Math.max(1, Math.floor(diff / (60 * 1000)))
  return `${mins}m`
}

</script>

<template>
  <div class="flex flex-col h-full">
    <header class="dashboard-panel-page-header justify-between">
      <div>
        <h2 class="font-heading text-lg font-bold">{{ $t('settings.members.title') }}</h2>
        <p class="text-xs text-muted-foreground">{{ $t('settings.members.subtitle') }}</p>
      </div>
      <button
        v-if="canManage"
        class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all flex items-center gap-2"
        @click="showInvite = true"
      >
        <Icon name="lucide:user-plus-2" size="14" />
        {{ $t('settings.members.invite') }}
      </button>
    </header>

    <div class="flex-1 overflow-y-auto">
      <div class="dashboard-panel-container dashboard-panel-stack">
        <!-- Deployment-provided line such as seat usage; empty unless overridden. -->
        <MembersHeaderInfo />
        <template v-if="loading">
          <p class="text-sm text-muted-foreground">{{ $t('settings.loading') }}</p>
        </template>

        <template v-else>
          <!-- Pending invitations -->
          <section v-if="invitations.length" class="dashboard-panel overflow-hidden">
            <div class="dashboard-panel-header border-b border-border">
              <h3 class="font-heading font-bold text-sm">{{ $t('settings.members.pending') }}</h3>
            </div>
            <ul class="divide-y divide-border">
              <li v-for="inv in invitations" :key="inv.id" class="dashboard-panel-row flex items-center gap-3">
                <div class="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <Icon name="lucide:mail" size="14" class="text-muted-foreground" />
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-semibold truncate">{{ inv.email }}</p>
                  <p class="text-[11px] text-muted-foreground truncate">
                    {{ $t('settings.members.invitedAs') }} <span class="font-semibold capitalize">{{ roleLabel(inv.role) }}</span>
                    <template v-if="inv.expiresAt"> · {{ $t('settings.members.expiresIn', { time: formatExpiresIn(inv.expiresAt) }) }}</template>
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
                      {{ $t('settings.members.copyLink') }}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem class="text-red-600" @click="cancelInvitation(inv.id)">
                      <Icon name="lucide:x" size="13" class="mr-2" />
                      {{ $t('settings.members.revoke') }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            </ul>
          </section>

          <!-- Members table -->
          <section class="dashboard-panel overflow-hidden">
            <div class="dashboard-panel-header border-b border-border flex items-center justify-between">
              <h3 class="font-heading font-bold text-sm">{{ $t('settings.members.membersSection') }}</h3>
              <span class="text-[11px] text-muted-foreground">{{ $t('settings.members.total', { count: members.length }) }}<template v-if="suspendedCount"> · {{ $t('settings.members.suspendedCount', { count: suspendedCount }) }}</template></span>
            </div>
            <ul class="divide-y divide-border">
              <li v-for="m in members" :key="m.id" class="dashboard-panel-row flex items-center gap-3">
                <!-- UserAvatar drops fallthrough classes, so the suspended look goes on a wrapper. -->
                <span class="inline-flex shrink-0" :class="m.suspendedAt && 'opacity-50 grayscale'">
                  <UserAvatar :author="{ name: m.user.name, image: m.user.image }" :size="9" />
                </span>
                <div class="flex-1 min-w-0" :class="m.suspendedAt && 'opacity-60'">
                  <div class="flex items-center gap-2">
                    <p class="text-sm font-bold truncate" :class="m.suspendedAt && 'text-muted-foreground'">{{ m.user.name }}</p>
                    <span v-if="m.userId === myUserId" class="text-[10px] font-bold uppercase tracking-wider bg-muted text-muted-foreground px-1.5 py-0.5 rounded">{{ $t('settings.members.you') }}</span>
                    <span v-if="m.suspendedAt" class="text-[10px] font-bold uppercase tracking-wider border border-border text-muted-foreground px-1.5 py-0.5 rounded">{{ $t('settings.members.suspended') }}</span>
                  </div>
                  <p class="text-[11px] text-muted-foreground truncate">{{ m.user.email }}</p>
                </div>

                <button
                  v-if="m.suspendedAt && canManage"
                  class="h-8 px-3 rounded-md border border-border bg-background hover:bg-secondary transition-colors text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="activating === m.id"
                  @click="activateMember(m)"
                >
                  {{ $t('settings.members.activate') }}
                </button>

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
                      <span>{{ roleLabel(m.role) }}</span>
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
                  {{ roleLabel(m.role) }}
                </span>

                <!-- More -->
                <DropdownMenu v-if="canManage && m.userId !== myUserId">
                  <DropdownMenuTrigger as-child>
                    <button class="w-8 h-8 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground">
                      <Icon name="lucide:more-horizontal" size="14" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" class="w-[180px]">
                    <!-- Frees a seat without removing the member -->
                    <DropdownMenuItem v-if="!m.suspendedAt" :disabled="activating === m.id || !canSuspend(m)" @click="setSuspended(m, true)">
                      <Icon name="lucide:user-minus" size="13" class="mr-2" />
                      {{ $t('settings.members.suspend') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem v-else :disabled="activating === m.id" @click="activateMember(m)">
                      <Icon name="lucide:user-check" size="13" class="mr-2" />
                      {{ $t('settings.members.activate') }}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      class="text-red-600"
                      :disabled="m.role === 'owner' && ownerCount <= 1"
                      @click="removeMember(m)"
                    >
                      <Icon name="lucide:user-x" size="13" class="mr-2" />
                      {{ $t('settings.members.remove') }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            </ul>
          </section>

          <!-- Footnote about last owner safeguard -->
          <p class="text-[11px] text-muted-foreground leading-relaxed">
            <Icon name="lucide:shield-check" size="11" class="inline mr-1" />
            {{ $t('settings.members.lastOwnerNote') }}
          </p>
        </template>
      </div>
    </div>

    <Dialog v-model:open="showInvite">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="font-heading">{{ $t('settings.members.inviteTitle') }}</DialogTitle>
          <DialogDescription class="text-sm">
            {{ $t('settings.members.inviteDesc') }}
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <!-- Email-not-configured banner -->
          <div v-if="!emailConfigured" class="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
            <Icon name="lucide:mail-x" size="14" class="mt-0.5 shrink-0" />
            <div>
              <p class="font-bold">{{ $t('settings.members.emailNotConfigured') }}</p>
              <p class="mt-0.5 leading-relaxed">{{ $t('settings.members.emailNotConfiguredHint') }}</p>
            </div>
          </div>

          <!-- Emails input -->
          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.members.emailLabel') }}</label>
            <textarea
              v-model="inviteEmails"
              rows="2"
              :disabled="inviting"
              :placeholder="$t('settings.members.emailPlaceholder')"
              class="mt-2 w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary transition-colors resize-none disabled:opacity-60 disabled:cursor-not-allowed"
            />
            <p class="text-[11px] text-muted-foreground mt-1">{{ $t('settings.members.emailHint') }}</p>
          </div>

          <!-- Role -->
          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.members.roleLabel') }}</label>
            <Select v-model="inviteRole" :disabled="inviting">
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
              <span>{{ $t('settings.members.ownerWarning') }}</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <button class="h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors" @click="showInvite = false">
            {{ $t('common.cancel') }}
          </button>
          <button
            :disabled="!inviteEmails.trim() || inviting"
            class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            @click="sendInvite"
          >
            {{ inviting ? (emailConfigured ? $t('settings.members.sending') : $t('settings.members.creating')) : (emailConfigured ? $t('settings.members.sendInvites') : $t('settings.members.createInvites')) }}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
