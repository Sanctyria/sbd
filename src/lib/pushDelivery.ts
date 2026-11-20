import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { environment } from "../config/env.js";
import { pool } from "../db/client.js";

const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().email(),
  private_key: z.string().min(1),
});

type ClaimedDelivery = {
  event_id: string;
  device_id: string;
  fid: string;
  notification_id: string;
  notification_type: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  actor_avatar_url?: string | null;
  media_url?: string | null;
  media_kind?: string | null;
  post_preview?: string | null;
  post_author_name?: string | null;
  post_author_username?: string | null;
  community_name?: string | null;
  community_slug?: string | null;
  post_url?: string | null;
};

const MAX_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.slice(0, 100);
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause &&
    typeof error.cause.code === "string"
  ) {
    return error.cause.code.slice(0, 100);
  }
  return "unknown";
}

function safeErrorText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(/[\r\n\t]+/g, " ").trim();
  return sanitized ? sanitized.slice(0, 500) : undefined;
}

function errorDetails(error: unknown): Record<string, string> {
  if (typeof error !== "object" || error === null) {
    return { code: errorCode(error) };
  }

  const details: Record<string, string> = { code: errorCode(error) };
  if ("name" in error) {
    const name = safeErrorText(error.name);
    if (name) details.errorName = name;
  }
  if ("message" in error) {
    const message = safeErrorText(error.message);
    if (message) details.errorMessage = message;
  }
  if ("cause" in error && typeof error.cause === "object" && error.cause) {
    if ("code" in error.cause && typeof error.cause.code === "string") {
      details.causeCode = error.cause.code.slice(0, 100);
    }
    if ("message" in error.cause) {
      const causeMessage = safeErrorText(error.cause.message);
      if (causeMessage) details.causeMessage = causeMessage;
    }
  }
  return details;
}

export function isExpiredPushRegistration(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token" ||
    code === "messaging/installation-id-not-registered"
  );
}

function optionalPayloadString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function youtubeThumbnailUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  const host = url.hostname.toLowerCase();
  const videoId =
    host === "youtu.be"
      ? url.pathname.split("/").filter(Boolean)[0]
      : host === "youtube.com" || host === "www.youtube.com"
        ? url.searchParams.get("v") ??
          (url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] ??
            undefined)
        : undefined;
  return videoId && /^[a-zA-Z0-9_-]{6,20}$/.test(videoId)
    ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    : undefined;
}

export function makeMessage(delivery: ClaimedDelivery) {
  const action = optionalPayloadString(delivery.payload, "action");
  const actorName =
    optionalPayloadString(delivery.payload, "actorName") ?? "A community member";
  const actorUsername = optionalPayloadString(
    delivery.payload,
    "actorUsername",
  );
  const preview = optionalPayloadString(delivery.payload, "preview");
  const postPreview =
    delivery.post_preview ??
    optionalPayloadString(delivery.payload, "postPreview");
  const postAuthorName =
    delivery.post_author_name ??
    optionalPayloadString(delivery.payload, "postAuthorName");
  const postAuthorUsername =
    delivery.post_author_username ??
    optionalPayloadString(delivery.payload, "postAuthorUsername");
  const targetKind = optionalPayloadString(delivery.payload, "targetKind");
  const mentionType = optionalPayloadString(delivery.payload, "mentionType");
  const postContext =
    targetKind === "reply"
      ? postAuthorName
        ? `In ${postAuthorName}'s post`
        : postAuthorUsername
          ? `In @${postAuthorUsername}'s post`
          : "In this post"
      : "On your post";
  const communitySlug =
    delivery.community_slug ??
    optionalPayloadString(
      delivery.payload,
      "communitySlug",
    );
  const communityName =
    delivery.community_name ??
    optionalPayloadString(delivery.payload, "communityName");
  const title =
    optionalPayloadString(delivery.payload, "title") ??
    (delivery.notification_type === "system" && action === "follow"
      ? `${actorName} started following you`
      : delivery.notification_type === "reply"
        ? targetKind === "reply"
          ? `${actorName} replied to your reply`
          : `${actorName} replied to your post`
        : delivery.notification_type === "mention"
          ? action === "chat_message"
            ? mentionType === "everyone"
              ? `${actorName} notified everyone`
              : `${actorName} mentioned you`
            : `${actorName} mentioned you`
          : delivery.notification_type === "reaction"
            ? `${actorName} liked your post`
              : delivery.notification_type === "post"
                ? optionalPayloadString(delivery.payload, "title") ??
                  `${actorName} posted something new`
            : delivery.notification_type === "community"
              ? `${actorName} updated ${communityName ?? "your community"}`
              : "Sanctyria update");
  const body =
    optionalPayloadString(delivery.payload, "detail") ??
    (delivery.notification_type === "system" && action === "follow"
      ? `@${actorUsername ?? "member"} followed you.`
      : delivery.notification_type === "reaction"
        ? postPreview ?? "Tap to see the post they liked."
        : delivery.notification_type === "post"
          ? postPreview ?? "Tap to see the new post."
        : delivery.notification_type === "reply" ||
            delivery.notification_type === "mention"
          ? [
              preview ?? "Tap to view the conversation.",
              ...(postPreview ? [`${postContext}: ${postPreview}`] : []),
            ].join(" · ")
          : preview ?? "Open to view this community update.");
  const actorAvatarUrl =
    delivery.actor_avatar_url ??
    optionalPayloadString(delivery.payload, "actorAvatarUrl");
  const mediaUrl =
    delivery.media_url ?? optionalPayloadString(delivery.payload, "mediaUrl");
  const mediaKind =
    delivery.media_kind ?? optionalPayloadString(delivery.payload, "mediaKind");
  const postUrl =
    delivery.post_url ?? optionalPayloadString(delivery.payload, "postUrl");
  const imageUrl = mediaUrl ?? youtubeThumbnailUrl(postUrl) ?? actorAvatarUrl;
  const deepLink =
    delivery.notification_type === "community" && communitySlug
      ? `https://sanctyria.com/r/${encodeURIComponent(communitySlug)}`
      : delivery.notification_type === "mention" &&
          action === "chat_message" &&
          communitySlug
        ? `https://sanctyria.com/r/${encodeURIComponent(communitySlug)}`
      : delivery.notification_type === "system" && actorUsername
        ? `https://sanctyria.com/u/${encodeURIComponent(actorUsername)}`
        : delivery.entity_id
          ? `https://sanctyria.com/p/${encodeURIComponent(delivery.entity_id)}`
          : communitySlug
            ? `https://sanctyria.com/r/${encodeURIComponent(communitySlug)}`
            : "";
  const data = {
    notificationId: delivery.notification_id,
    notificationType: delivery.notification_type,
    entityId: delivery.entity_id ?? "",
    action: action ?? "",
    actorName,
    actorUsername: actorUsername ?? "",
    actorAvatarUrl: actorAvatarUrl ?? "",
    mediaUrl: mediaUrl ?? "",
    mediaKind: mediaKind ?? "",
    postUrl: postUrl ?? "",
    postPreview: postPreview ?? "",
    postAuthorName: postAuthorName ?? "",
    postAuthorUsername: postAuthorUsername ?? "",
    targetKind: targetKind ?? "",
    preview: preview ?? "",
    communityName: communityName ?? "",
    communitySlug: communitySlug ?? "",
    title: title.slice(0, 100),
    body: body.slice(0, 240),
    deepLink,
  };
  const supportsPostActions =
    delivery.entity_id !== null &&
    ["reply", "mention", "reaction"].includes(delivery.notification_type);

  return {
    fid: delivery.fid,
    data,
    android: {
      priority: "high" as const,
      ttl: 60 * 60 * 1000,
      notification: {
        title: data.title,
        body: data.body,
        channelId: "community_notifications",
        sound: "default",
      },
    },
    apns: {
      headers: { "apns-priority": "10" },
      payload: {
        aps: {
          alert: { title: data.title, body: data.body },
          sound: "default",
          mutableContent: Boolean(imageUrl),
          ...(supportsPostActions ? { category: "community_actions" } : {}),
        },
      },
      ...(imageUrl ? { fcmOptions: { imageUrl } } : {}),
    },
  };
}

async function enqueueNotificationEvents(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const events = await client.query<{
      id: string;
      recipient_id: string | null;
    }>(
      `select id, recipient_id
       from outbox_events
       where topic = 'notification.created' and push_processed_at is null
       order by created_at, id
       limit 25
       for update skip locked`,
    );

    for (const event of events.rows) {
      if (event.recipient_id) {
        await client.query(
          `insert into push_deliveries (event_id, device_id)
           select $1, id
           from push_devices
           where user_id = $2
           on conflict (event_id, device_id) do nothing`,
          [event.id, event.recipient_id],
        );
      }
      await client.query(
        `update outbox_events
         set push_processed_at = now()
         where id = $1`,
        [event.id],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function claimDeliveries(): Promise<ClaimedDelivery[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const deliveries = await client.query<ClaimedDelivery>(
      `select
         pd.event_id,
         pd.device_id,
        d.token as fid,
         n.id as notification_id,
         n.type as notification_type,
         n.entity_id,
         n.payload,
         pd.attempts,
         (
           select actor_profile.avatar_url
           from profiles actor_profile
           where actor_profile.username = n.payload->>'actorUsername'
           limit 1
         ) as actor_avatar_url,
         (
           select case
             when notification_post.kind in ('image_url', 'video_url')
               then notification_post.url
             else null
           end
           from posts notification_post
           where notification_post.id = n.entity_id
             and notification_post.deleted_at is null
           limit 1
         ) as media_url,
         (
           select notification_post.kind
           from posts notification_post
           where notification_post.id = n.entity_id
             and notification_post.deleted_at is null
           limit 1
         ) as media_kind,
         (
           select left(notification_post.body, 180)
           from posts notification_post
           where notification_post.id = n.entity_id
             and notification_post.deleted_at is null
           limit 1
         ) as post_preview,
         (
           select notification_post_author.display_name
           from posts notification_post
           inner join profiles notification_post_author
             on notification_post_author.user_id = notification_post.author_id
           inner join users notification_post_user
             on notification_post_user.id = notification_post.author_id
             and notification_post_user.deleted_at is null
           where notification_post.id = n.entity_id
             and notification_post.deleted_at is null
           limit 1
         ) as post_author_name,
         (
           select notification_post_author.username
           from posts notification_post
           inner join profiles notification_post_author
             on notification_post_author.user_id = notification_post.author_id
           inner join users notification_post_user
             on notification_post_user.id = notification_post.author_id
             and notification_post_user.deleted_at is null
           where notification_post.id = n.entity_id
             and notification_post.deleted_at is null
           limit 1
         ) as post_author_username,
         (
           select notification_community.name
           from posts notification_post
           inner join communities notification_community
             on notification_community.id = notification_post.community_id
           where notification_post.id = n.entity_id
             and notification_post.deleted_at is null
           limit 1
         ) as community_name,
         (
           select notification_community.slug
           from posts notification_post
           inner join communities notification_community
             on notification_community.id = notification_post.community_id
           where notification_post.id = n.entity_id
             and notification_post.deleted_at is null
           limit 1
         ) as community_slug
         ,
         (
           select notification_post.url
           from posts notification_post
           where notification_post.id = n.entity_id
             and notification_post.kind = 'link'
             and notification_post.deleted_at is null
           limit 1
         ) as post_url
       from push_deliveries pd
       inner join outbox_events e on e.id = pd.event_id
       inner join notifications n on n.id = e.entity_id
       inner join push_devices d on d.id = pd.device_id
       where pd.delivered_at is null
         and pd.attempts < $1
         and pd.next_attempt_at <= now()
         and (
           pd.claimed_at is null
           or pd.claimed_at < now() - interval '5 minutes'
         )
       order by pd.next_attempt_at, pd.event_id, pd.device_id
       limit 50
       for update of pd skip locked`,
      [MAX_ATTEMPTS],
    );

    for (const delivery of deliveries.rows) {
      await client.query(
        `update push_deliveries
         set claimed_at = now(), attempts = attempts + 1
         where event_id = $1 and device_id = $2`,
        [delivery.event_id, delivery.device_id],
      );
      delivery.attempts++;
    }
    await client.query("commit");
    return deliveries.rows;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function processDelivery(
  delivery: ClaimedDelivery,
  messaging: ReturnType<typeof getMessaging>,
  logger: FastifyBaseLogger,
): Promise<void> {
  try {
    await messaging.send(makeMessage(delivery));
    await pool.query(
      `update push_deliveries
       set delivered_at = now(), claimed_at = null, last_error = null
       where event_id = $1 and device_id = $2`,
      [delivery.event_id, delivery.device_id],
    );
  } catch (error) {
    const code = errorCode(error);
    if (isExpiredPushRegistration(error)) {
      await pool.query("delete from push_devices where id = $1", [
        delivery.device_id,
      ]);
      logger.info(
        { deviceId: delivery.device_id, code },
        "Removed an expired push device token",
      );
      return;
    }

    const retryDelayMs = Math.min(
      30_000 * 2 ** Math.max(0, delivery.attempts - 1),
      MAX_RETRY_DELAY_MS,
    );
    await pool.query(
      `update push_deliveries
       set claimed_at = null,
           next_attempt_at = now() + ($3 * interval '1 millisecond'),
           last_error = $4
       where event_id = $1 and device_id = $2`,
      [delivery.event_id, delivery.device_id, retryDelayMs, code],
    );
    logger.error(
      {
        eventId: delivery.event_id,
        deviceId: delivery.device_id,
        attempt: delivery.attempts,
        ...errorDetails(error),
      },
      "Push notification delivery failed",
    );
  }
}

export function startPushDeliveryWorker(
  logger: FastifyBaseLogger,
): (() => void) | undefined {
  if (
    !environment.FIREBASE_SERVICE_ACCOUNT_JSON &&
    !environment.GOOGLE_APPLICATION_CREDENTIALS
  ) {
    return undefined;
  }

  const account = environment.FIREBASE_SERVICE_ACCOUNT_JSON
    ? serviceAccountSchema.parse(
        JSON.parse(environment.FIREBASE_SERVICE_ACCOUNT_JSON),
      )
    : undefined;
  const credential = account
    ? cert({
        projectId: account.project_id,
        clientEmail: account.client_email,
        privateKey: account.private_key,
      })
    : applicationDefault();
  const firebaseApp =
    getApps().find((app) => app.name === "sanctyria-push") ??
    initializeApp(
      {
        credential,
      },
      "sanctyria-push",
    );
  const messaging = getMessaging(firebaseApp);
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await enqueueNotificationEvents();
      const deliveries = await claimDeliveries();
      await Promise.all(
        deliveries.map((delivery) =>
          processDelivery(delivery, messaging, logger),
        ),
      );
    } catch (error) {
      logger.error(errorDetails(error), "Push notification worker failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), 5_000);
  timer.unref();
  void run();
  logger.info("Firebase push notification worker started");
  return () => clearInterval(timer);
}
