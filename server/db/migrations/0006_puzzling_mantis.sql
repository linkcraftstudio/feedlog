CREATE TABLE "post_subscription" (
	"post_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_subscription_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
-- Backfill: authors subscribe to their own posts (skip org admins).
INSERT INTO "post_subscription" ("post_id", "user_id")
SELECT p.id, p.author_id
FROM "post" p
WHERE NOT EXISTS (
	SELECT 1 FROM "member" m
	WHERE m.user_id = p.author_id AND m.organization_id = p.org_id
		AND m.role IN ('owner', 'manager')
)
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Backfill: voters subscribe to posts they upvoted (skip org admins).
INSERT INTO "post_subscription" ("post_id", "user_id")
SELECT v.post_id, v.user_id
FROM "vote" v
JOIN "post" p ON p.id = v.post_id
WHERE NOT EXISTS (
	SELECT 1 FROM "member" m
	WHERE m.user_id = v.user_id AND m.organization_id = p.org_id
		AND m.role IN ('owner', 'manager')
)
ON CONFLICT DO NOTHING;
