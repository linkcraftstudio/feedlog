// Client-side CRUD for agent tokens, backed by /api/developer/agent-tokens
// (owner-only). Unlike SSO secrets, the token itself is NOT recoverable: the
// list endpoint returns a display prefix only, and the raw value comes back
// exactly once, from create(). The caller must show it immediately or it is
// gone — see server/utils/agent-token.ts.

import type { AgentTokenRole } from '~~/shared/constants/agent'

export interface AgentToken {
  id: string
  label: string | null
  prefix: string
  role: string
  allowDelete: boolean
  createdAt: string
  expiresAt: string
  expired: boolean
}

export interface AgentTokenCreated extends AgentToken {
  token: string
}

export interface CreateAgentTokenInput {
  label?: string
  role?: AgentTokenRole
  expiresInDays?: number
  allowDelete?: boolean
}

export function useAgentTokens() {
  const tokens = ref<AgentToken[]>([])
  const loading = ref(true)
  const error = ref<string | null>(null)

  async function refresh() {
    loading.value = true
    error.value = null
    try {
      tokens.value = await $fetch<AgentToken[]>('/api/developer/agent-tokens')
    }
    catch (e) {
      error.value = (e as { data?: { message?: string } })?.data?.message || 'Failed to load agent tokens'
    }
    finally {
      loading.value = false
    }
  }

  // Returns the created row INCLUDING the raw token. Keep it only as long as it
  // takes the user to copy it; never persist it client-side.
  async function create(input: CreateAgentTokenInput): Promise<AgentTokenCreated> {
    const created = await $fetch<AgentTokenCreated>('/api/developer/agent-tokens', {
      method: 'POST',
      body: input,
    })
    const { token: _token, ...row } = created
    tokens.value = [row as AgentToken, ...tokens.value]
    return created
  }

  // Grant or withdraw the delete capability on a token that already exists.
  // Deliberately does not re-mint: the agent's configured token keeps working,
  // it simply may or may not delete from the next request onwards.
  async function setAllowDelete(id: string, allowDelete: boolean): Promise<void> {
    const updated = await $fetch<AgentToken>(`/api/developer/agent-tokens/${id}`, {
      method: 'PATCH',
      body: { allowDelete },
    })
    const i = tokens.value.findIndex(t => t.id === id)
    if (i >= 0) tokens.value[i] = updated
  }

  async function remove(id: string): Promise<void> {
    await $fetch(`/api/developer/agent-tokens/${id}`, { method: 'DELETE' })
    tokens.value = tokens.value.filter(t => t.id !== id)
  }

  return { tokens, loading, error, refresh, create, setAllowDelete, remove }
}
