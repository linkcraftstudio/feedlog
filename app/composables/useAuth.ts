import { authClient } from '~/lib/auth-client'

export function useAuth() {
  return authClient
}

// better-auth session response type
interface AuthSession {
  user: {
    id: string
    name: string
    email: string
    image: string | null
    isAnonymous?: boolean
    role: string | null
  }
  session: {
    id: string
    token: string
    expiresAt: string
  }
}

// SSR-compatible session fetching
// Uses Nuxt useFetch to call better-auth session endpoint, ensuring correct SSR → client payload transfer
export function useAuthSession() {
  return useFetch<AuthSession | null>('/api/auth/get-session', {
    key: 'auth-session',
  })
}
