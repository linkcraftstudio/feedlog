CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" varchar(200),
	"preview_text" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unread" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"kind" varchar(16),
	"text" text NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"post_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_conversation_owner" ON "conversation" USING btree ("org_id","user_id","last_message_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "idx_message_conversation" ON "message" USING btree ("conversation_id","created_at","id");