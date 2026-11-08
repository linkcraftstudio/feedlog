# Widget configuration and display controls

Install the [Widget SDK](https://github.com/linkcraftstudio/feedlog-widget) in
your product and configure it with your FeedLog workspace URL. The dashboard's
Widget settings page provides installation examples, launcher defaults and
assistant settings.

## Dashboard settings

The enable switch saves immediately. Feedback button and assistant settings each have
their own **Save changes** and **Cancel changes** actions. Editing a rule updates
the assistant draft; save that section to apply it. Failed saves retain the draft.

Launcher placement defaults to the right side, 20px from the bottom and side.
Desktop and mobile share these settings; the SDK adds device safe-area insets.
Offsets have no fixed pixel limit. The SDK and preview keep the button within
their viewport without changing the configured values.
**Reset position** changes the placement draft only. Save it to apply the reset;
the selected closing behavior and visitor preferences remain unchanged.

| Closing behavior | Result |
| --- | --- |
| Do not allow closing | No launcher close button. |
| Collapse to a Help tab | A small tab stays against the screen edge. This is the default. Clicking it restores the button and opens feedback. |
| Hide for now | The launcher disappears until the page reloads or the SDK is reinitialized. |

The preview supports dragging, opening, closing and resetting the launcher. It
uses the current draft and does not create conversations or save visitor state.

## Conversation language

Widget controls, greetings and connection errors follow the configured Widget
interface language (English or Chinese). AI replies follow the customer's
requested language or the established conversation language, including languages
without a Widget translation.

AI-initiated human handoffs use `customer_notice` from the handoff tool call,
translated from the matching confirmation template into the conversation
language. The confirmation is saved in the handoff event only when the transfer
succeeds. Both the live `handoff` stream event and customer history include this
text as `customerNotice`; changing the interface language or reopening the
conversation preserves it. Legacy handoff events without saved text retain the
existing interface-language fallback. No database migration is required.

Inbox displays the saved customer confirmation verbatim in the conversation
bubble. Its internal handoff reason and rule details still follow the staff
interface language; they are not part of the customer confirmation.

## Human takeover in Inbox

In **Inbox**, filter by **AI handling** or **All**, open a conversation and click
**Take over and reply** in place of the send button. The conversation becomes
**Open** immediately when AI is idle. If AI is replying, the request is saved
and the button shows **Waiting for AI to finish replying**. The current reply
finishes and is saved in full before the conversation becomes **Open** and the
staff reply field is enabled. AI failure or its existing timeout also completes
the takeover; refreshing or leaving the dashboard does not lose the request.
This is a shared inbox action; it does not assign an exclusive owner.
The send button replaces the takeover button once human replies are available.
Takeover records stay in the staff timeline; the customer sees the completed AI
answer followed by actual staff replies, with no extra takeover message.

Staff keep using the existing reply, snooze and close actions. There is no
return-to-AI action. A new customer message in a closed conversation starts a
new AI round in that same conversation, with recent customer and staff history.
History remains bounded to the existing memory window and size budget; a new
conversation does not read another conversation's messages.

`POST /api/admin/inbox/conversations/{id}/actions` accepts
`{ action: 'takeover', requestId: UUID, expectedLastSeq: number }` with the
existing `feedlog:inbox` permission, idempotency and revision checks. Only
`ai_handling` conversations can be taken over. No database migration is required.
Admin conversation responses include `takeoverPending`, derived from the saved
request and active run. Pending requests are internal and do not announce a human
before the current AI round ends. Explicitly closing a conversation still cancels
its run and invalidates any waiting takeover for that round.

## Configuration API

`GET /api/widget/config` is public and returns:

```json
{
  "enabled": true,
  "allowGuest": false,
  "org": { "name": "Acme", "logo": null },
  "branding": { "primary": "#C45A46", "primaryForeground": "#FFFFFF" },
  "launcher": {
    "alignment": "right",
    "bottomOffset": 20,
    "sideOffset": 20,
    "closeBehavior": "collapse"
  }
}
```

`allowGuest` follows the workspace's guest-posting setting. Branding and identity
come from the workspace; the foreground color is calculated from its brand color.

`GET /api/admin/widget` and `PATCH /api/admin/widget` require the
`feedlog:moderate` permission. The admin API uses `launcherConfig` for the same
four launcher properties. A launcher update sends the complete object:

```json
{
  "launcherConfig": {
    "alignment": "left",
    "bottomOffset": 32,
    "sideOffset": 24,
    "closeBehavior": "hide"
  }
}
```

Alignment must be `left` or `right`; offsets must be non-negative safe integers;
closing behavior must be `none`, `collapse` or `hide`. Invalid or incomplete
objects return HTTP 400. Omit `launcherConfig` to leave it unchanged. Each update
writes only the submitted settings fields. Rule-count validation and the update
run under the same row lock so concurrent saves cannot bypass the rule limit.

## Storage and upgrades

Migration `0015_widget_launcher_config` adds one non-null JSONB column,
`organization_widget.launcher_config`, with the right/20/20/collapse object as
its default. Validation is handled by the application. Existing workspace
settings are preserved; a workspace with no settings row uses the same defaults.
Run `pnpm migrate` as part of upgrading a self-hosted instance.

Visitor positions and button/tab preferences are stored in the host page's
`sessionStorage`, scoped by FeedLog URL. They survive reloads within that tab.
Fully hidden state is kept only in memory. None of these preferences is written
to the organization settings table.

## Host integration

Explicit SDK placement overrides dashboard defaults. A visitor's dragged
position takes priority over both. Dragging docks the launcher to the nearest
left or right edge; the feedback panel chooses a position within the viewport.

The SDK exports `createWidget`, `openWidget`, `closeWidget` and `updateWidget`.
Use `updateWidget({ theme, launcher, zIndex })` for partial display updates.
Launcher `state` is `button`, `tab` or `hidden`; hiding the launcher does not
close the panel or prevent a custom help entry from calling `openWidget()`.
Explicit runtime position updates replace a saved drag. Other updates retain it.

The default z-index is 40, allowing host dialogs to cover the widget. Override it
when your application's layer scale differs. Close the panel with `closeWidget()`
when a business dialog needs room; launcher visibility is controlled separately.

Promise-based `auth.login` hides the widget until the interaction exits and
identity is checked again. Synchronous callbacks remain visible and require no
completion signal, preserving SDK 0.0.6 behavior.

Live theme updates require an iframe that advertises theme support. The SDK keeps
an older frame's current theme instead of reloading and losing its draft. Initial
theme selection remains compatible through the iframe URL parameter.

Restoring a conversation draft, attachments and reading position across sign-in
requires matching SDK and hosted iframe support. Resume messages validate the
parent/frame origin and source; a different signed-in account cannot inherit
the previous account's state. See the [SDK integration guide](https://github.com/linkcraftstudio/feedlog-widget#host-login-lifecycle)
for examples and compatibility details.
