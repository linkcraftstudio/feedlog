export interface PublicAuthConfig {
  mcp?: boolean
  google: boolean
  github: boolean
  email: boolean
  emailVerification: boolean
  emailProvider?: boolean
  externalLoginUrl: string | null
  externalSignupUrl: string | null
}

export function isAuthConfigUnavailable(
  config: PublicAuthConfig | null | undefined,
  localAuthRequired = false,
): boolean {
  return !localAuthRequired && !config
}

export function useAuthConfig() {
  return useFetch<PublicAuthConfig>('/api/auth-config', {
    key: 'auth-config',
  })
}
