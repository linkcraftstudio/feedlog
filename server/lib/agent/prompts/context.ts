import { listHelpCatalog, HELP_CATALOG_PROMPT_BUDGET } from '../help-catalog'
import type { Pool } from 'pg'
import type { Actor } from '../runtime'
import type { AgentPromptBoard, AgentPromptContext } from './system'
import { resolveGuestAccess } from '../../../../shared/utils/guest'
import { getEnabledSupportRules, type WidgetConfigRow } from '../../../../shared/utils/widget-settings'
import { isActorAdmin, type OrgListSession } from '../../../../shared/utils/notifications'
import { isGuestSession } from '../../../utils/guest'

export async function agentProduct(pool: Pool, orgId: string) {
  const { rows: [organization] } = await pool.query<{ name: string }>('SELECT name FROM organization WHERE id=$1', [orgId])
  if (!organization) throw new Error('Organization not found')
  return {
    name: organization.name,
  }
}

export async function loadAgentPromptContext(pool: Pool, actor: Actor): Promise<AgentPromptContext> {
  const [organization, widget, boards, articles, websites] = await Promise.all([
    pool.query<{ metadata: string | null }>('SELECT metadata FROM organization WHERE id=$1', [actor.orgId]),
    pool.query<WidgetConfigRow>(`SELECT enabled,support_email AS "supportEmail",disabled_builtins AS "disabledBuiltins",custom_rules AS "customRules",conversation_retention_days AS "conversationRetentionDays" FROM organization_widget WHERE org_id=$1`, [actor.orgId]),
    pool.query<AgentPromptBoard>('SELECT id,name,description FROM board WHERE org_id=$1 ORDER BY position,id', [actor.orgId]),
    listHelpCatalog(pool, actor.orgId, { budget: HELP_CATALOG_PROMPT_BUDGET }),
    pool.query<{ available: boolean }>(`SELECT EXISTS(SELECT 1 FROM ai_training_web_page d JOIN ai_training_website s ON s.id=d.website_id AND s.org_id=d.org_id WHERE d.org_id=$1 AND d.indexed_at IS NOT NULL AND s.ai_enabled) AS available`, [actor.orgId]),
  ])
  const metadata = organization.rows[0]?.metadata
  const guest = resolveGuestAccess(metadata)
  const anonymous = isGuestSession(actor.session)
  const settings = widget.rows[0]
  const product = await agentProduct(pool, actor.orgId)
  return {
    productName: product.name,
    boards: boards.rows,
    supportEmail: settings?.supportEmail,
    supportRules: getEnabledSupportRules(settings),
    knowledgeEnabled: articles.total > 0 || websites.rows[0]?.available === true,
    websiteSourcesAvailable: websites.rows[0]?.available === true,
    articles: articles.articles,
    articleCatalog: { total: articles.total, complete: articles.complete, nextOffset: articles.nextOffset },
    feedback: {
      create: (!anonymous || guest.allowPost) && boards.rows.length > 0,
      vote: !anonymous || guest.allowVote,
      subscribe: !isActorAdmin(actor.session as OrgListSession, actor.orgId),
      commentScope: !anonymous || guest.allowComment ? 'all' : 'own',
    },
  }
}
