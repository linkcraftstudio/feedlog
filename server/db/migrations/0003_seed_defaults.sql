-- Data-only migration: seed default boards + welcome post + welcome changelog.
-- Ensures a fresh install has visible content on day one.
--
-- Safety: each INSERT is gated on the target table being empty, so upgrades
-- from an existing v0.1 install (which already has boards/posts/changelogs)
-- are a no-op — we don't pollute production data with "Welcome" rows.
--
-- The sentinel `system` user authors these rows. It has no `account` record,
-- so it cannot log in; it only satisfies NOT NULL author_id text columns.

INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
VALUES ('system', 'FeedLog Team', 'system@feedlog.local', true, now(), now())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "board" ("id", "name", "description", "position", "created_at", "updated_at")
SELECT * FROM (VALUES
  ('00000000-0000-4000-a0ad-000000000001'::uuid, 'Feature Requests', 'Submit your feature requests and improvement ideas', 0, now(), now()),
  ('00000000-0000-4000-a0ad-000000000002'::uuid, 'Bug Report',       'Report issues and unexpected behavior you encounter', 1, now(), now()),
  ('00000000-0000-4000-a0ad-000000000003'::uuid, 'Improvements',     'Suggestions for optimizing existing features',       2, now(), now()),
  ('00000000-0000-4000-a0ad-000000000004'::uuid, 'Other',            'Other feedback and suggestions',                     3, now(), now())
) AS v(id, name, description, position, created_at, updated_at)
WHERE NOT EXISTS (SELECT 1 FROM "board");
--> statement-breakpoint

INSERT INTO "post" (
  "id", "board_id", "author_id", "slug", "status", "title", "excerpt", "content",
  "vote_count", "comment_count", "created_at", "updated_at"
)
SELECT
  '00000000-0000-4000-a0e1-000000000001'::uuid,
  '00000000-0000-4000-a0ad-000000000004'::uuid,
  'system',
  'welcome-to-feedlog',
  'in_progress',
  'Welcome to FeedLog — your install is live',
  'FeedLog is up and running. Browse boards, upvote ideas, and start collecting real feedback from your users.',
  '# Welcome to FeedLog 🎉

Your install is live. This is where user ideas land — browse the boards, upvote what matters, and turn feedback into a roadmap.

## Next steps

- **Customize boards** — rename, reorder, or add your own in `/dashboard/boards`.
- **Post your first changelog** — ship something and tell your users in `/dashboard/changelogs`.
- **Invite teammates** — give them admin access to triage incoming ideas.
- **Connect OAuth** — set `GITHUB_CLIENT_ID` / `GOOGLE_CLIENT_ID` so users can sign in with one click.

## Need help?

- Docs: https://github.com/linkcraftstudio/feedlog
- Discussions: https://github.com/linkcraftstudio/feedlog/discussions

Feel free to delete this post once you have real feedback rolling in.',
  0, 0, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "post");
--> statement-breakpoint

INSERT INTO "changelog" (
  "id", "author_id", "slug", "status", "title", "content", "categories",
  "published_title", "published_content", "published_categories",
  "published_at", "created_at", "updated_at"
)
SELECT
  '00000000-0000-4000-a0e3-000000000001'::uuid,
  'system',
  'feedlog-is-ready',
  'published',
  'FeedLog is ready to go',
  'Welcome! Your FeedLog install is up. Publish your own changelog entries from `/dashboard/changelogs` — keep users in the loop when features ship, and react with emoji to celebrate.',
  '[]'::jsonb,
  'FeedLog is ready to go',
  'Welcome! Your FeedLog install is up. Publish your own changelog entries from `/dashboard/changelogs` — keep users in the loop when features ship, and react with emoji to celebrate.',
  '[]'::jsonb,
  now(), now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "changelog");
