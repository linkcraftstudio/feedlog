// The prompt behind "Copy installation as prompt" on the widget settings page:
// pasted into the user's own coding agent (Codex, Claude Code, Cursor), it
// installs the widget in guest mode without asking anything, then offers single
// sign-on. The guest install is spelled out in full so it never depends on the
// agent reading the docs; anything optional points at help.feedlog.ai instead
// of being repeated here. English only: the agent is told to reply in the
// user's language.
const TEMPLATE = `Add the FeedLog widget to this project. FeedLog is a customer support and feedback platform; the widget is a floating button that opens an AI support panel answering from the workspace's Help Center, where customers can also leave feedback. My FeedLog workspace URL is {{workspaceUrl}}. Current FeedLog settings, nothing to change unless marked:
- Widget: {{widget}}
- Guest feedback: {{guestFeedback}}

Work directly in this repository: inspect the code, make the changes, run the project's checks and verify the result. Don't stop at instructions or sample code. Reply in the language I use, follow the repository's own instructions (AGENTS.md, CLAUDE.md, contribution guides) and its existing conventions, and don't commit or deploy unless I ask. Only touch what the widget needs.

## Docs

For anything this prompt doesn't cover, use the FeedLog docs at https://help.feedlog.ai. Start with /developers/widget, or /developers/sso for sign-in, and follow links to other pages when they help. Don't guess APIs from memory. If you can't open the docs, ask me.

## Step 1 — Install in guest mode (do this now, no questions)

1. Find the app that serves the product UI (in a monorepo, pick that package) and its package manager.
2. Add \`@feedlog/widget\` with that package manager.
3. Call \`createWidget\` once, in browser-only startup code that runs once per page load: for example a Nuxt \`.client\` plugin, a \`useEffect\` in the root layout of a React or Next.js app (in a \`'use client'\` file for the App Router), or \`onMounted\` in the root component of a Vue app. Never during server rendering and never per route.

   import { createWidget } from '@feedlog/widget'

   createWidget({
     baseUrl: '{{workspaceUrl}}',
     theme: 'auto',
   })

   If the project keeps public URLs in config or env variables, put the workspace URL there. It is not a secret.
4. Run the project's lint, typecheck and build as relevant. Keep failures that existed before your change separate from yours.
5. If you can open the app in a browser, check that the FeedLog button appears once, the panel opens and closes, and it stays after navigating to another page.
6. Report the files you changed and what you verified. Then, if the product has its own user accounts, ask:

   "The FeedLog widget is installed in guest mode. Do you also want it to recognize your signed-in users (single sign-on), so their conversations and feedback are tied to their accounts?"

   Stop and wait for my answer. Do step 2 only if I say yes.

## Step 2 — Signed-in users with single sign-on (only if I say yes)

Read https://help.feedlog.ai/developers/widget#integrate-existing-product-accounts and https://help.feedlog.ai/developers/sso#jwt-requirements before writing code. These rules always apply:

- Add a server endpoint behind the app's existing sign-in that signs an HS256 JWT for the current user: \`email\` (required) taken from the trusted server session, never from the browser; optional \`name\` and \`picture\`; \`exp\` one hour ahead, never more than 24 hours.
- Pass \`auth\` to the existing \`createWidget\` call. \`getToken\` returns the token when signed in, returns \`null\` only when the app confirms the user is signed out, and throws on any network or unexpected error, because \`null\` signs the customer out of the widget. \`login\` opens the app's existing sign-in (route, modal or redirect); for a modal, return a promise that settles when it closes, including on cancel.
- The secret is created in FeedLog → Developer → Single Sign-On (workspace owners only). It is server-only: no \`NEXT_PUBLIC_\`, \`VITE_\`, \`NUXT_PUBLIC_\` or similar prefix, never in browser code, logs or version control. Add an empty placeholder to the example env file and tell me where to set the real value. Never ask me to paste it into this chat.
- If this repository has only the frontend or only the backend, finish the half that is safe to build here and tell me what is left.
- Don't claim signed-in behaviour works until the real secret is configured.

## When done

Summarize briefly:
- the files changed;
- guest mode or single sign-on;
- the checks you ran;
- anything I still need to do, only if this install actually needs it (for example a setting marked off above, or the SSO secret and its env variable).

Finally, mention that I can install FeedLog Skills (\`npx skills add linkcraftstudio/feedlog-skills\`) and connect FeedLog's MCP server (Settings → MCP in my FeedLog dashboard), so you can keep adjusting the widget later and help manage feedback and Help Center articles.
`

// The two settings that decide whether a guest install works, stated as facts so
// the agent neither reports them as to-dos nor guesses: left unsaid, it lists
// every setting the docs mention. A snapshot taken when the prompt is copied.
// Guest voting and commenting are left out on purpose: the embedded widget only
// submits feedback, so they don't affect the install.
export interface WidgetAgentPromptSettings {
  widgetOn: boolean
  guestFeedbackOn: boolean
}

export function widgetAgentPrompt(workspaceUrl: string, settings: WidgetAgentPromptSettings): string {
  const widget = settings.widgetOn
    ? 'on'
    : 'off, so the button stays hidden until it is turned on in FeedLog → Settings → Widget'
  const guestFeedback = settings.guestFeedbackOn
    ? 'on, so visitors can use the widget without signing in'
    : 'off, so signed-out visitors can\'t send feedback; turn it on in FeedLog → Settings → Workspace → Guest permissions, or set up single sign-on'
  return TEMPLATE
    .replaceAll('{{workspaceUrl}}', workspaceUrl)
    .replace('{{widget}}', widget)
    .replace('{{guestFeedback}}', guestFeedback)
}
