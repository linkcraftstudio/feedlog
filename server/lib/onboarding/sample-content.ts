import type { HelpCollectionIcon } from '../../../shared/constants/help'
import type { HandoffReason } from '../../../shared/inbox/state'

// Sample data written into a new organization so its first visit shows the
// whole loop: AI answers from articles, a handoff waiting for a person,
// feedback extracted from chats. It is ordinary data afterwards — the titles
// carry [Sample] because nothing else marks it and the user must delete it
// before going live. English only. `{{product}}` becomes the organization name.

export const SAMPLE_PREFIX = '[Sample] '

export type SampleCollectionKey = 'gettingStarted' | 'accountBilling'
export type SampleArticleKey = 'invite' | 'reports' | 'signIn' | 'billing'
export type SampleCustomerKey = 'emma' | 'daniel' | 'nora' | 'sofia'
export type SampleFeedbackKey = 'csvExport' | 'lateEmails'

export const SAMPLE_COLLECTIONS: { key: SampleCollectionKey; name: string; description: string; icon: HelpCollectionIcon }[] = [
  { key: 'gettingStarted', name: 'Getting started', description: 'Set up your workspace and share your work.', icon: 'rocket' },
  { key: 'accountBilling', name: 'Account & billing', description: 'Sign-in, plans, invoices and refunds.', icon: 'settings-2' },
]

export const SAMPLE_ARTICLES: { key: SampleArticleKey; collection: SampleCollectionKey; title: string; description: string; content: string }[] = [
  {
    key: 'invite',
    collection: 'gettingStarted',
    title: '[Sample] Invite teammates and manage roles',
    description: 'How to invite people to your workspace, choose their role and resend invitations.',
    content: `## Invite a teammate
1. Go to **Settings → Members**.
2. Click **Invite** and enter one or more email addresses.
3. Choose a role and click **Send invitations**.

Each person receives an email with a link to join your workspace in {{product}}.

## Roles
- **Admin** — manages members, billing and workspace settings.
- **Member** — uses all features but cannot change billing or remove people.

You can change someone's role at any time from **Settings → Members**.

## Resend or cancel an invitation
Invitations expire after 7 days. Open **Settings → Members → Pending**, then choose **Resend** or **Cancel**. If an invitation doesn't arrive, ask the person to check their spam folder.
`,
  },
  {
    key: 'reports',
    collection: 'gettingStarted',
    title: '[Sample] Share and export reports',
    description: 'Share a read-only link to a report or download it as PDF or PNG.',
    content: `## Share a read-only link
Open the report and click **Share → Copy link**. Anyone with the link can view the report but cannot edit it. Turn the link off at any time from the same menu.

## Download a report
Click **Share → Download** and choose **PDF** (best for printing and email) or **PNG** (best for slides). The file includes the date range and filters currently applied.

## Send reports by email on a schedule
Click **Share → Schedule email**, pick the recipients and how often — daily, weekly or monthly. Recipients don't need a {{product}} account.
`,
  },
  {
    key: 'signIn',
    collection: 'accountBilling',
    title: '[Sample] Sign-in and password reset',
    description: 'Reset a forgotten password and fix common sign-in problems.',
    content: `## Reset your password
1. On the sign-in page, click **Forgot password?**
2. Enter the email address you use for {{product}}.
3. Open the reset link we email you and choose a new password.

The link is valid for 1 hour. If it has expired, request a new one.

## Didn't get the reset email?
Check your spam folder and make sure you entered the email address you signed up with. If you signed up with Google, use **Continue with Google** instead — there is no separate password.

## Still can't sign in?
If your account is locked or you no longer have access to your email address, contact our support team. For security reasons, a person needs to verify your identity.
`,
  },
  {
    key: 'billing',
    collection: 'accountBilling',
    title: '[Sample] Plans, billing and refunds',
    description: 'Change or cancel your plan, find invoices and learn how refunds work.',
    content: `## Change your plan
Go to **Settings → Billing** and click **Change plan**. Upgrades take effect immediately and are prorated. Downgrades take effect at the end of the current billing period.

## Cancel your subscription
Go to **Settings → Billing → Cancel subscription**. You keep access until the end of the period you've paid for, and your data is kept for 30 days in case you come back.

## Invoices
Every payment has an invoice under **Settings → Billing → Invoices**. You can download it as a PDF or add your company details for future invoices.

## Refunds
Monthly plans are not refunded for partial months. Annual plans can be refunded in full within 14 days of purchase. Refunds go back to the original payment method and usually appear within 5–10 business days, depending on your bank.

If you see a charge you don't recognize or were charged twice, contact our support team and include the invoice numbers so we can look into it.
`,
  },
]

// Named but undeliverable: `.invalid` never resolves, and the org id prefix
// keeps the globally unique email column free of clashes between orgs.
export const SAMPLE_CUSTOMERS: { key: SampleCustomerKey; name: string; emailLocal: string }[] = [
  { key: 'emma', name: 'Emma Chen', emailLocal: 'emma.chen' },
  { key: 'daniel', name: 'Daniel Park', emailLocal: 'daniel.park' },
  { key: 'nora', name: 'Nora Schmidt', emailLocal: 'nora.schmidt' },
  { key: 'sofia', name: 'Sofia Martinez', emailLocal: 'sofia.martinez' },
]

export function sampleCustomerEmail(emailLocal: string, orgId: string) {
  return `${emailLocal}-${orgId.slice(0, 8)}@sample.invalid`
}

// Times are minutes before the seed runs. Votes come from sample customers only.
export const SAMPLE_FEEDBACK: { key: SampleFeedbackKey; board: string; title: string; content: string; status: 'open' | 'planned'; author: SampleCustomerKey; voters: SampleCustomerKey[]; minutesAgo: number }[] = [
  {
    key: 'csvExport',
    board: 'Feature Requests',
    title: '[Sample] Export reports to CSV',
    content: `Our finance team needs the raw numbers behind reports every month. Today reports can only be downloaded as PDF or PNG, so they copy the figures by hand.

Please add a CSV export option for reports.`,
    status: 'open',
    author: 'daniel',
    voters: [],
    // Created by the AI reply in Daniel's conversation.
    minutesAgo: 119.6,
  },
  {
    key: 'lateEmails',
    board: 'Bug Report',
    title: '[Sample] Comment notification emails arrive late',
    content: 'Email notifications for new comments arrive 10–15 minutes after the comment is posted. In-app notifications show up right away, so the delay seems to be in email delivery.',
    status: 'planned',
    author: 'sofia',
    voters: ['sofia', 'nora'],
    minutesAgo: 4380,
  },
]

export type SampleStep =
  | { kind: 'customer'; minutesAgo: number; text: string }
  | { kind: 'agent'; minutesAgo: number; text: string; articles?: SampleArticleKey[]; feedback?: { key: SampleFeedbackKey; type: 'feedback_created' | 'feedback_upvoted' } }
  // The AI round that hands off ends cancelled and leaves no text of its own.
  | { kind: 'handoff'; minutesAgo: number; reason: HandoffReason; ruleId?: string }
  | { kind: 'closed'; minutesAgo: number }

export interface SampleConversation {
  customer: SampleCustomerKey
  status: 'ai_handling' | 'open' | 'closed'
  steps: SampleStep[]
}

// AI conversations keep state_due_at NULL so they stay in "AI handling" when the
// user comes back days later. The closed one closes 48 hours after its last AI
// reply, as the inbox timeout would have.
export const SAMPLE_CONVERSATIONS: SampleConversation[] = [
  {
    customer: 'emma',
    status: 'open',
    steps: [
      { kind: 'customer', minutesAgo: 25, text: 'How long does a refund take to show up on my card?' },
      { kind: 'agent', minutesAgo: 24.8, text: 'Refunds go back to the original payment method. Once a refund is issued, it usually appears on your statement within 5–10 business days, depending on your bank.', articles: ['billing'] },
      { kind: 'customer', minutesAgo: 21, text: 'Thanks. We were also charged twice for the Team plan this month. Can you refund the duplicate charge?' },
      { kind: 'handoff', minutesAgo: 20.9, reason: 'support_rule', ruleId: 'builtin-billing' },
      { kind: 'customer', minutesAgo: 18, text: 'Both charges are on the same day and for the same amount. The invoice numbers end in 1042 and 1043.' },
    ],
  },
  {
    customer: 'daniel',
    status: 'ai_handling',
    steps: [
      { kind: 'customer', minutesAgo: 120, text: 'Can I export a report to CSV? Our finance team needs the raw numbers every month.' },
      { kind: 'agent', minutesAgo: 119.6, text: 'Right now reports can be downloaded as PDF or PNG, or shared with a read-only link — CSV export isn\'t available yet. I\'ve recorded CSV export as a feature request so the product team can see it, and you\'ll get an update when its status changes.', articles: ['reports'], feedback: { key: 'csvExport', type: 'feedback_created' } },
      { kind: 'customer', minutesAgo: 117, text: 'Perfect, thanks!' },
      { kind: 'agent', minutesAgo: 116.8, text: 'You\'re welcome! Let me know if there\'s anything else I can help with.' },
    ],
  },
  {
    customer: 'nora',
    status: 'ai_handling',
    steps: [
      { kind: 'customer', minutesAgo: 300, text: 'Email notifications for new comments arrive 10–15 minutes late. Is something wrong on your side?' },
      { kind: 'agent', minutesAgo: 299.6, text: 'Thanks for reporting this. Other customers have reported the same delay, and the team already plans to fix it. I\'ve added your vote and subscribed you, so you\'ll be notified when it\'s fixed.', feedback: { key: 'lateEmails', type: 'feedback_upvoted' } },
    ],
  },
  {
    customer: 'sofia',
    status: 'closed',
    steps: [
      { kind: 'customer', minutesAgo: 4320, text: 'How do I invite my teammates to our workspace?' },
      { kind: 'agent', minutesAgo: 4319.6, text: 'Go to **Settings → Members** and click **Invite**. Enter their email addresses and choose a role for each person — Admins can manage billing and members, Members can use everything else. Invitations expire after 7 days, and you can resend them from the same page.', articles: ['invite'] },
      { kind: 'customer', minutesAgo: 4316, text: 'Found it, thanks!' },
      { kind: 'agent', minutesAgo: 4315.8, text: 'Glad that helped! If anyone doesn\'t receive the invitation, ask them to check their spam folder or resend it from Settings → Members.' },
      { kind: 'closed', minutesAgo: 4315.8 - 48 * 60 },
    ],
  },
]
