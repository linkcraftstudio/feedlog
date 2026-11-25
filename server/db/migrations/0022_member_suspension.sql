ALTER TABLE "member" ADD COLUMN "suspended_at" timestamp;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "suspended_reason" text;