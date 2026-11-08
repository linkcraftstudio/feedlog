CREATE TABLE "help_article_chunk" (
	"article_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"org_id" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"heading" text NOT NULL,
	"body" text NOT NULL,
	"model" text NOT NULL,
	"index_version" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	CONSTRAINT "help_article_chunk_article_id_ordinal_pk" PRIMARY KEY("article_id","ordinal")
);
--> statement-breakpoint
CREATE INDEX "idx_help_chunk_org" ON "help_article_chunk" USING btree ("org_id");
