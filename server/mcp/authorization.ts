import { createResourceServerChallenge } from '@better-auth/oauth-provider'
import { APIError } from 'better-auth/api'
import { createDpopReplayStore, createInsufficientScopeError, enforceDpopBinding, parseAccessTokenAuthorization, verifyJwsAccessToken } from 'better-auth/oauth2'
import { getMcpAuth } from '../utils/better-auth'
import { activeGrant, grantOrganizations } from './grants'
import { MCP_SCOPES, type mcpConfig } from './config'

export interface McpIdentity { consentId: string; userId: string; clientId: string; resource: string }
export const invalidMcpToken = () => new APIError('UNAUTHORIZED', { error: 'invalid_token', error_description: 'Authorization is missing, expired or revoked' })

export async function verifyMcpRequest(request: Request, config: ReturnType<typeof mcpConfig>): Promise<McpIdentity> {
  const authorization = parseAccessTokenAuthorization(request.headers.get('authorization'))
  if (!authorization || !['Bearer', 'DPoP'].includes(authorization.scheme)) throw invalidMcpToken()
  const provider = getMcpAuth(config)
  // Use the provider's local keys, never a request-host-derived remote JWKS URL.
  const claims = await verifyJwsAccessToken(authorization.token, {
    jwksFetch: () => provider.api.getJwks(),
    jwksCacheKey: provider,
    verifyOptions: { issuer: config.issuer, audience: config.resource },
  })
  await enforceDpopBinding({
    payload: claims, authorization, proofJwt: request.headers.get('DPoP'), method: request.method, url: request.url,
    replayStore: createDpopReplayStore((await provider.$context).internalAdapter),
  })
  if (typeof claims.scope !== 'string' || !claims.scope.split(' ').includes('mcp:access')) throw createInsufficientScopeError(['mcp:access'])
  if (typeof claims.sub !== 'string' || typeof claims.client_id !== 'string' || typeof claims.mcp_consent_id !== 'string') throw invalidMcpToken()
  const identity = { consentId: claims.mcp_consent_id, userId: claims.sub, clientId: claims.client_id, resource: config.resource }
  await requireActiveIdentity(identity)
  return identity
}
export async function requireActiveIdentity(identity: McpIdentity) {
  const grant = await activeGrant(identity.consentId)
  if (!grant || grant.consent.userId !== identity.userId || grant.consent.clientId !== identity.clientId
    || !grant.consent.scopes.includes('mcp:access')
    || !grant.consent.resources?.includes(identity.resource) || !(await grantOrganizations(identity.consentId, identity.userId)).length) throw invalidMcpToken()
  return grant
}
export function mcpChallenge(error: unknown, resource: string) {
  // Clients that follow only the 401 scope hint must also request refresh access.
  // Tool authorization still requires only mcp:access; 403 scopes come from the error.
  const challenge = createResourceServerChallenge(error, resource, { challengeScopes: MCP_SCOPES })
    ?? createResourceServerChallenge(invalidMcpToken(), resource, { challengeScopes: MCP_SCOPES })!
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: challenge.message }, id: null }), {
    status: challenge.statusCode, headers: { ...challenge.headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
