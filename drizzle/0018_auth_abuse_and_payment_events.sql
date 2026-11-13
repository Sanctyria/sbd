CREATE TABLE "auth_rate_limits" (
	"action" text NOT NULL,
	"bucket_hash" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_rate_limits_action_bucket_hash_pk" PRIMARY KEY("action","bucket_hash")
);
--> statement-breakpoint
CREATE INDEX "auth_rate_limits_window_idx" ON "auth_rate_limits" USING btree ("window_started_at");
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"amount_minor" integer,
	"currency" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_events_provider_event_uidx" ON "payment_webhook_events" USING btree ("provider","external_event_id");
--> statement-breakpoint
CREATE INDEX "payment_webhook_events_received_idx" ON "payment_webhook_events" USING btree ("received_at");
