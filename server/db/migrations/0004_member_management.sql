-- Member management: introduce better-auth's organization plugin.
-- Adds organization / member / invitation tables, backfills business tables
-- with org_id, and rebuilds access-path indexes for org-scoped queries.
--
-- Open-source runs single-tenant — a hidden 'default-org' is the install's
-- only workspace, and the plugin powers /dashboard/settings/members (invite,
-- role assignment, removal). The same schema also supports multi-org
-- deployments without further migration.
--
-- Single transaction: drizzle-kit wraps each migration file in BEGIN/COMMIT,
-- so any failure rolls back the entire change. No down migration provided —
-- once member / org rows exist, structural rollback would lose them.

-- ===========================================================================
-- 1. Auth-layer new tables (better-auth organization plugin schema)
-- ===========================================================================

CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint

CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"team_id" text,
	"inviter_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk"
	FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk"
	FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk"
	FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "member_org_user_unique" ON "member" USING btree ("organization_id","user_id");
--> statement-breakpoint
CREATE INDEX "invitation_org_idx" ON "invitation" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");
--> statement-breakpoint

-- session.active_organization_id: better-auth plugin's "last visited org"
-- column. UX convenience only — never used for data isolation in FeedLog.
ALTER TABLE "session" ADD COLUMN "active_organization_id" text;
--> statement-breakpoint

-- ===========================================================================
-- 2. Default organization seed (idempotent — survives re-runs / opensource bootstrap)
-- ===========================================================================

INSERT INTO "organization" ("id", "name", "slug", "created_at")
VALUES ('default-org', 'Default', 'default', now())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- ===========================================================================
-- 3. Business tables: add nullable org_id, backfill, tighten to NOT NULL
-- ===========================================================================

ALTER TABLE "board" ADD COLUMN "org_id" text;
--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "org_id" text;
--> statement-breakpoint
ALTER TABLE "changelog" ADD COLUMN "org_id" text;
--> statement-breakpoint
ALTER TABLE "post_embedding" ADD COLUMN "org_id" text;
--> statement-breakpoint
ALTER TABLE "post_search" ADD COLUMN "org_id" text;
--> statement-breakpoint

UPDATE "board" SET "org_id" = 'default-org' WHERE "org_id" IS NULL;
--> statement-breakpoint
UPDATE "post" SET "org_id" = 'default-org' WHERE "org_id" IS NULL;
--> statement-breakpoint
UPDATE "changelog" SET "org_id" = 'default-org' WHERE "org_id" IS NULL;
--> statement-breakpoint
UPDATE "post_embedding" SET "org_id" = 'default-org' WHERE "org_id" IS NULL;
--> statement-breakpoint
UPDATE "post_search" SET "org_id" = 'default-org' WHERE "org_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "board" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "post" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "changelog" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "post_embedding" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "post_search" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint

-- ===========================================================================
-- 4. Member row backfill from existing user table
--   - user.role='admin' → owner (one-time projection; pre-member-management
--     admins were the effective top operators of their install — mapping them
--     to owner preserves their ability to manage / invite / delete the
--     workspace. user.role itself is no longer consulted after this migration.)
--   - 'system' sentinel author of welcome content → NOT inserted (it has no
--     `account` row and can't log in; FK from welcome post / changelog only
--     needs the `user` row to exist, not membership)
--   - other users → NOT inserted (they remain end-users in `user` table only)
-- ===========================================================================

INSERT INTO "member" ("id", "organization_id", "user_id", "role", "created_at")
SELECT
	gen_random_uuid()::text AS id,
	'default-org' AS organization_id,
	"user"."id" AS user_id,
	'owner' AS role,
	now() AS created_at
FROM "user"
WHERE "user"."role" = 'admin' AND "user"."id" <> 'system'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ===========================================================================
-- 5. Drop old global UNIQUE on slug; build per-org UNIQUE
-- ===========================================================================

ALTER TABLE "post" DROP CONSTRAINT "post_slug_unique";
--> statement-breakpoint
ALTER TABLE "changelog" DROP CONSTRAINT "changelog_slug_unique";
--> statement-breakpoint

CREATE UNIQUE INDEX "idx_post_org_slug" ON "post" USING btree ("org_id","slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_changelog_org_slug" ON "changelog" USING btree ("org_id","slug");
--> statement-breakpoint

-- ===========================================================================
-- 6. Index rebuild: org_id as leftmost field on access-path indexes
-- ===========================================================================

DROP INDEX "idx_post_created";
--> statement-breakpoint
DROP INDEX "idx_post_votes";
--> statement-breakpoint
DROP INDEX "idx_post_board_created";
--> statement-breakpoint
DROP INDEX "idx_post_board_votes";
--> statement-breakpoint
DROP INDEX "idx_post_board_status";
--> statement-breakpoint
DROP INDEX "idx_post_status_votes";
--> statement-breakpoint
DROP INDEX "idx_changelog_public";
--> statement-breakpoint
DROP INDEX "idx_changelog_admin";
--> statement-breakpoint

CREATE INDEX "idx_post_org_created" ON "post" USING btree ("org_id","created_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX "idx_post_org_votes" ON "post" USING btree ("org_id","vote_count" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX "idx_post_org_board_created" ON "post" USING btree ("org_id","board_id","created_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX "idx_post_org_board_votes" ON "post" USING btree ("org_id","board_id","vote_count" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX "idx_post_org_board_status" ON "post" USING btree ("org_id","board_id","status","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_post_org_status_votes" ON "post" USING btree ("org_id","status","vote_count" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX "idx_board_org_position" ON "board" USING btree ("org_id","position");
--> statement-breakpoint
CREATE INDEX "idx_changelog_org_public" ON "changelog" USING btree ("org_id","published_at" DESC,"id" DESC) WHERE "changelog"."published_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_changelog_org_admin" ON "changelog" USING btree ("org_id","updated_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX "idx_post_embedding_org" ON "post_embedding" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_post_search_org" ON "post_search" USING btree ("org_id");
