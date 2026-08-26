CREATE TABLE "agent_token" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"label" text,
	"prefix" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_token" ADD CONSTRAINT "agent_token_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_token" ADD CONSTRAINT "agent_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_token_org" ON "agent_token" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_token_session" ON "agent_token" USING btree ("session_id");