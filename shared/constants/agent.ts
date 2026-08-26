// Agent-token constants, shared between the mint API (cap + clamp enforcement),
// the session guard (identifying an agent) and the dashboard UI (button gating).

// Placeholder address for the robot rows an agent token authenticates as.
// `.invalid` is reserved by RFC 2606, so the address can never be registered and
// can never receive mail — which is the point: no inbox means no password reset,
// and with no credential row of any kind the robot has no way in through the
// login form at all.
//
// Deliberately a *subdomain* of the guest domain's parent rather than the guest
// domain itself, so isGuestEmail() never matches an agent and the two identity
// kinds stay independently testable.
export const AGENT_EMAIL_DOMAIN = 'agents.feedlog.invalid'

export function isAgentEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${AGENT_EMAIL_DOMAIN}`)
}

// Cap per org. An agent token is a standing credential, not something to mint
// casually; a handful covers "one per agent, plus one mid-rotation".
export const AGENT_TOKEN_LIMIT = 5

// Lifetime bounds, in days. The default is long enough that the credential is
// not a chore and short enough that a forgotten token eventually dies on its
// own. The ceiling is the outer limit the create endpoint will clamp to.
export const AGENT_TOKEN_DEFAULT_DAYS = 90
export const AGENT_TOKEN_MAX_DAYS = 365

// Roles an agent may be given. `owner` is deliberately absent — an agent must
// never be able to administer the org, and `contributor` exists for a read-and-
// comment agent that should not be able to moderate.
export const AGENT_TOKEN_ROLES = ['manager', 'contributor'] as const
export type AgentTokenRole = typeof AGENT_TOKEN_ROLES[number]

// How much of the raw token the dashboard stores and shows so two tokens can be
// told apart in a list. Display only — never part of the credential check.
export const AGENT_TOKEN_PREFIX_LENGTH = 8
