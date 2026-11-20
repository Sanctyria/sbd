CREATE TABLE "community_chat_message_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_chat_message_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
ALTER TABLE "community_chat_messages" ADD COLUMN "reply_to_id" uuid;--> statement-breakpoint
ALTER TABLE "community_chat_messages" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "community_chat_messages" ADD COLUMN "shared_item_type" text;--> statement-breakpoint
ALTER TABLE "community_chat_messages" ADD COLUMN "shared_item_id" text;--> statement-breakpoint
ALTER TABLE "community_chat_messages" ADD COLUMN "shared_item" jsonb;--> statement-breakpoint
ALTER TABLE "community_chat_message_reactions" ADD CONSTRAINT "community_chat_message_reactions_message_id_community_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."community_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_chat_message_reactions" ADD CONSTRAINT "community_chat_message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_chat_message_reactions_message_idx" ON "community_chat_message_reactions" USING btree ("message_id");