CREATE TABLE "ai_training_web_page" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"website_id" uuid NOT NULL,
	"run_id" uuid,
	"url" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"indexed_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_training_website" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"url" text NOT NULL,
	"input_type" text DEFAULT 'website' NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"frequency" text DEFAULT 'weekly' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"excludes" text DEFAULT '' NOT NULL,
	"page_limit" integer DEFAULT 200 NOT NULL,
	"next_run" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_training_website_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"website_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"total" integer NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "help_article_chunk" RENAME TO "content_chunk";--> statement-breakpoint
ALTER TABLE "content_chunk" RENAME COLUMN "article_id" TO "content_id";--> statement-breakpoint
DROP INDEX "idx_help_chunk_org";--> statement-breakpoint
ALTER TABLE "content_chunk" DROP CONSTRAINT "help_article_chunk_article_id_ordinal_pk";--> statement-breakpoint
ALTER TABLE "content_chunk" ADD COLUMN "content_type" text DEFAULT 'help_article' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_chunk" ADD CONSTRAINT "content_chunk_content_type_content_id_ordinal_pk" PRIMARY KEY("content_type","content_id","ordinal");--> statement-breakpoint
ALTER TABLE "help_collection" ADD COLUMN "ai_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_training_web_page_website_url" ON "ai_training_web_page" USING btree ("website_id","url");--> statement-breakpoint
CREATE INDEX "ai_training_web_page_org" ON "ai_training_web_page" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_training_website_org_url" ON "ai_training_website" USING btree ("org_id","url");--> statement-breakpoint
CREATE INDEX "ai_training_website_run_website" ON "ai_training_website_run" USING btree ("website_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_content_chunk_org_type" ON "content_chunk" USING btree ("org_id","content_type");
--> statement-breakpoint
ALTER TABLE "content_chunk" ALTER COLUMN "embedding" SET DATA TYPE vector;