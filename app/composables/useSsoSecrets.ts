// Client-side CRUD for product-SSO signing secrets, backed by
// /api/developer/sso/secrets (owner-only). Secrets come back in full
// (plaintext, recoverable) so the list can re-reveal them.

export interface SsoSecret {
  id: string
  label: string | null
  secret: string
  enabled: boolean
  createdAt: string
}

export function useSsoSecrets() {
  const secrets = ref<SsoSecret[]>([])
  const loading = ref(true)
  const error = ref<string | null>(null)

  async function refresh() {
    loading.value = true
    error.value = null
    try {
      secrets.value = await $fetch<SsoSecret[]>('/api/developer/sso/secrets')
    }
    catch (e) {
      error.value = (e as { data?: { message?: string } })?.data?.message || 'Failed to load secrets'
    }
    finally {
      loading.value = false
    }
  }

  async function create(label: string): Promise<SsoSecret> {
    const created = await $fetch<SsoSecret>('/api/developer/sso/secrets', {
      method: 'POST',
      body: { label },
    })
    secrets.value = [created, ...secrets.value]
    return created
  }

  async function update(id: string, patch: { enabled?: boolean, label?: string }): Promise<void> {
    const updated = await $fetch<SsoSecret>(`/api/developer/sso/secrets/${id}`, {
      method: 'PATCH',
      body: patch,
    })
    const i = secrets.value.findIndex(s => s.id === id)
    if (i >= 0) secrets.value[i] = updated
  }

  async function remove(id: string): Promise<void> {
    await $fetch(`/api/developer/sso/secrets/${id}`, { method: 'DELETE' })
    secrets.value = secrets.value.filter(s => s.id !== id)
  }

  return { secrets, loading, error, refresh, create, update, remove }
}
