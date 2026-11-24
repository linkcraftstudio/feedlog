<script setup lang="ts">
import { toast } from 'vue-sonner'
import type { McpApplication, McpConnections, McpConnectionOrganizations } from '#layers/feedlog/shared/types/mcp'

definePageMeta({ layout: 'dashboard', middleware: ['admin'] })
const { t, locale } = useI18n()
useHead({ title: 'MCP · FeedLog' })
const page = ref(1)
const { data, error, status, refresh } = await useFetch<McpConnections>('/api/mcp/connections', { query: { page, pageSize: 20 } })
const manageOpen = ref(false)
const managed = ref<McpConnectionOrganizations | null>(null)
const selected = ref<string[]>([])
const original = ref<string[]>([])
const saving = ref(false)
const manageLoading = ref(false)
const changed = computed(() => selected.value.length !== original.value.length || selected.value.some(id => !original.value.includes(id)))
const confirmation = ref<{ kind: 'revoke' | 'disconnect' | 'clear'; application: McpApplication | null } | null>(null)
const confirmationOpen = computed({ get: () => !!confirmation.value, set: value => { if (!value && !saving.value) confirmation.value = null } })
const failure = ref('')

function errorMessage(cause: unknown) {
  return (cause as { data?: { message?: string }; message?: string }).data?.message || t('mcp.operationFailed')
}
function date(value: string) {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
function lastActive(value: string | null) {
  if (!value) return t('mcp.notUsed')
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000))
  if (!minutes) return t('mcp.justNow')
  const formatter = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' })
  return minutes < 60 ? formatter.format(-minutes, 'minute') : minutes < 1440 ? formatter.format(-Math.floor(minutes / 60), 'hour') : formatter.format(-Math.floor(minutes / 1440), 'day')
}
async function manage(application: McpApplication) {
  managed.value = null; failure.value = ''; manageOpen.value = true; manageLoading.value = true
  try {
    managed.value = await useApiFetch<McpConnectionOrganizations>(`/api/mcp/connections/${encodeURIComponent(application.id)}/organizations`)
    original.value = managed.value.organizations.filter(org => org.authorized).map(org => org.id)
    selected.value = [...original.value]
  } catch (cause) { failure.value = errorMessage(cause) }
  finally { manageLoading.value = false }
}
async function saveOrganizations() {
  if (!managed.value || saving.value) return
  saving.value = true; failure.value = ''
  try {
    await useApiFetch(`/api/mcp/connections/${encodeURIComponent(managed.value.connectionId)}/organizations`, {
      method: 'PATCH', body: { addOrganizationIds: selected.value.filter(id => !original.value.includes(id)), removeOrganizationIds: original.value.filter(id => !selected.value.includes(id)) },
    })
    manageOpen.value = false; confirmation.value = null
    await refresh()
    toast.success(t('mcp.accessUpdated'))
  } catch (cause) { failure.value = errorMessage(cause) }
  finally { saving.value = false }
}
function save() {
  if (!selected.value.length) confirmation.value = { kind: 'clear', application: null }
  else void saveOrganizations()
}
async function confirm() {
  const action = confirmation.value
  if (!action || saving.value) return
  if (action.kind === 'clear') return saveOrganizations()
  saving.value = true; failure.value = ''
  try {
    const path = `/api/mcp/connections/${encodeURIComponent(action.application!.id)}`
      + (action.kind === 'revoke' ? `/organizations/${encodeURIComponent(data.value!.organization.id)}` : '')
    await useApiFetch(path, { method: 'DELETE' })
    confirmation.value = null
    await refresh()
    toast.success(t('mcp.accessRevoked'))
  } catch (cause) { failure.value = errorMessage(cause) }
  finally { saving.value = false }
}
function confirmAction(kind: 'revoke' | 'disconnect', application: McpApplication) {
  failure.value = ''
  confirmation.value = { kind, application }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="dashboard-panel-page-header">
      <div>
        <h1 class="font-heading text-lg font-bold">MCP</h1>
        <p class="text-xs text-muted-foreground">{{ t('mcp.subtitle') }}</p>
      </div>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="dashboard-panel-container dashboard-panel-stack">
        <div v-if="error" role="alert" class="dashboard-panel dashboard-panel-body"><p class="mb-3 text-sm">{{ errorMessage(error) }}</p><Button variant="outline" size="sm" @click="refresh()">{{ t('mcp.retry') }}</Button></div>
        <p v-else-if="!data" role="status" class="text-sm text-muted-foreground">{{ t('a11y.loading') }}</p>
        <template v-if="data">
          <McpConnect :server-url="data.serverUrl" />
          <McpSkills />
          <section class="dashboard-panel overflow-hidden">
            <div class="dashboard-panel-header border-b border-border"><h2 class="font-heading text-sm font-bold">{{ t('mcp.connectedApplications') }} <span class="ml-1 text-muted-foreground">{{ data.pagination.total }}</span></h2><p class="mt-1 text-xs text-muted-foreground">{{ t('mcp.connectionsDescription', { organization: data.organization.name }) }}</p></div>
            <div class="overflow-x-auto">
              <table v-if="data.items.length" class="w-full min-w-[620px] text-left">
                <thead class="bg-muted/30 text-xs text-muted-foreground"><tr><th class="px-6 py-3 font-normal">{{ t('mcp.application') }}</th><th class="px-4 py-3 font-normal">{{ t('mcp.authorizedBy') }}</th><th class="px-4 py-3 font-normal">{{ t('mcp.authorized') }}</th><th class="px-4 py-3 font-normal">{{ t('mcp.lastActive') }}</th><th class="relative w-12"><span class="sr-only">{{ t('mcp.actions') }}</span></th></tr></thead>
                <tbody class="divide-y divide-border">
                  <tr v-for="application in data.items" :key="application.id" class="text-xs">
                    <td class="px-6 py-3.5"><span class="flex items-center gap-3"><McpLogo :type="application.client.type" :size="16" /><span class="max-w-48 truncate font-semibold" :title="application.client.name">{{ application.client.name }}</span></span></td>
                    <td class="px-4 py-3.5"><span class="flex items-center gap-2"><Avatar class="size-6"><AvatarImage v-if="application.authorizedBy.image" :src="application.authorizedBy.image" alt="" /><AvatarFallback class="bg-secondary text-[10px] text-primary">{{ application.authorizedBy.name.slice(0, 2).toUpperCase() }}</AvatarFallback></Avatar><span class="max-w-40 truncate">{{ application.authorizedBy.name }} <span v-if="application.isOwn" class="text-muted-foreground">({{ t('mcp.you') }})</span></span></span></td>
                    <td class="whitespace-nowrap px-4 py-3.5 text-muted-foreground">{{ date(application.authorizedAt) }}</td>
                    <td class="whitespace-nowrap px-4 py-3.5 text-muted-foreground" :title="application.lastUsedAt ? date(application.lastUsedAt) : ''">{{ lastActive(application.lastUsedAt) }}</td>
                    <td class="pr-3">
                      <DropdownMenu v-if="application.actions.manageOrganizations || application.actions.revokeOrganization">
                        <DropdownMenuTrigger as-child><Button variant="ghost" size="icon-sm" :aria-label="t('mcp.applicationActions', { application: application.client.name, person: application.authorizedBy.name })"><Icon name="lucide:ellipsis" class="size-4" /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem v-if="application.actions.manageOrganizations" @select="manage(application)"><Icon name="lucide:building-2" class="size-4" />{{ t('mcp.manageOrganizations') }}</DropdownMenuItem>
                          <DropdownMenuSeparator v-if="application.actions.manageOrganizations" />
                          <DropdownMenuItem v-if="application.actions.revokeOrganization" variant="destructive" @select="confirmAction('revoke', application)"><Icon name="lucide:shield-x" class="size-4" />{{ t('mcp.revokeOrganization') }}</DropdownMenuItem>
                          <DropdownMenuItem v-if="application.actions.disconnect" variant="destructive" @select="confirmAction('disconnect', application)"><Icon name="lucide:unplug" class="size-4" />{{ t('mcp.disconnectEverywhere') }}</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="px-6 py-10 text-center text-sm text-muted-foreground">{{ t('mcp.noConnections') }}</p>
            </div>
            <div v-if="data.pagination.total > data.pagination.pageSize" class="flex items-center justify-end gap-3 border-t border-border px-6 py-3 text-xs"><Button variant="outline" size="sm" :disabled="page <= 1 || status === 'pending'" @click="page--">{{ t('mcp.previous') }}</Button><span>{{ page }}</span><Button variant="outline" size="sm" :disabled="page * data.pagination.pageSize >= data.pagination.total || status === 'pending'" @click="page++">{{ t('mcp.next') }}</Button></div>
          </section>
          <p class="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground"><Icon name="lucide:shield-check" class="mt-0.5 size-3.5 shrink-0" /><span>{{ t('mcp.permissionsNote') }}</span></p>
        </template>
      </div>
    </div>
    <Dialog v-model:open="manageOpen">
      <DialogContent class="sm:max-w-md" @interact-outside="saving && $event.preventDefault()" @escape-key-down="saving && $event.preventDefault()">
        <DialogHeader><DialogTitle>{{ t('mcp.manageOrganizations') }}</DialogTitle><DialogDescription>{{ managed?.client.name || t('a11y.loading') }}</DialogDescription></DialogHeader>
        <p v-if="manageLoading" class="text-sm text-muted-foreground">{{ t('a11y.loading') }}</p>
        <McpOrganizations v-else-if="managed" v-model="selected" :organizations="managed.organizations" :disabled="saving" />
        <p v-if="failure" role="alert" class="text-sm text-destructive">{{ failure }}</p>
        <DialogFooter><Button variant="outline" :disabled="saving" @click="manageOpen = false">{{ t('common.cancel') }}</Button><Button :disabled="!managed || !changed || saving" @click="save">{{ t('common.save') }}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog v-model:open="confirmationOpen">
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{{ t(confirmation?.kind === 'revoke' ? 'mcp.revokeTitle' : 'mcp.disconnectTitle') }}</AlertDialogTitle><AlertDialogDescription>{{ confirmation?.kind === 'revoke' ? t('mcp.revokeDescription', { organization: data?.organization.name }) : t('mcp.disconnectDescription') }}</AlertDialogDescription></AlertDialogHeader>
        <p v-if="failure" role="alert" class="text-sm text-destructive">{{ failure }}</p>
        <AlertDialogFooter><AlertDialogCancel :disabled="saving">{{ t('common.cancel') }}</AlertDialogCancel><Button variant="destructive" :disabled="saving" @click="confirm">{{ t(confirmation?.kind === 'revoke' ? 'mcp.revoke' : 'mcp.disconnect') }}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
