CREATE TABLE "push_deliveries" (
	"event_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "push_deliveries_event_id_device_id_pk" PRIMARY KEY("event_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_token_hash" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_devices_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "push_processed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "outbox_events" SET "push_processed_at" = now() WHERE "topic" = 'notification.created' AND "push_processed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_event_id_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."outbox_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_device_id_push_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."push_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_session_token_hash_user_sessions_token_hash_fk" FOREIGN KEY ("session_token_hash") REFERENCES "public"."user_sessions"("token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_deliveries_ready_idx" ON "push_deliveries" USING btree ("delivered_at","next_attempt_at","claimed_at");--> statement-breakpoint
CREATE INDEX "push_devices_user_idx" ON "push_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "push_devices_session_idx" ON "push_devices" USING btree ("session_token_hash");