import { HANDOFF_NOTICES, handoffCustomerNotice } from '../../../shared/inbox/state'

export const handoffCustomerNoticeInput = handoffCustomerNotice.describe(
  'The customer-facing transfer confirmation, in the customer\'s requested language or the language of this conversation. A short acceptance such as "yes" keeps the established conversation language. Ignore the website, widget and staff interface language. Translate only the matching template below; add no queue position, wait time, promise of contact, internal rule text, or private details. Use handoff unless reason=support_rule; for support_rule use handoffBilling for builtin-billing, handoffAccount for builtin-account-access, handoffPrivacy for builtin-privacy-legal, otherwise handoffRule. This text is displayed only after a successful transfer. Templates: '
  + JSON.stringify(HANDOFF_NOTICES),
)
