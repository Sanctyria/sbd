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

export function makeMessage(delivery: ClaimedDelivery) {
  const title =
    optionalPayloadString(delivery.payload, "title") ??
    optionalPayloadString(delivery.payload, "actorName") ??
    "Sanctyria";
  const body =
    optionalPayloadString(delivery.payload, "detail") ??
    optionalPayloadString(delivery.payload, "preview") ??
    "You have a new notification.";
  const communitySlug = optionalPayloadString(
    delivery.payload,
    "communitySlug",
  );
  const actorUsername = optionalPayloadString(
    delivery.payload,
    "actorUsername",
  );
  const deepLink =
    communitySlug
      ? `https://sanctyria.com/r/${encodeURIComponent(communitySlug)}`
      : delivery.notification_type === "community" ||
          delivery.notification_type === "system"
        ? actorUsername
          ? `https://sanctyria.com/u/${encodeURIComponent(actorUsername)}`
          : ""
        : delivery.entity_id
          ? `https://sanctyria.com/p/${encodeURIComponent(delivery.entity_id)}`
          : actorUsername
            ? `https://sanctyria.com/u/${encodeURIComponent(actorUsername)}`
            : "";

  return {
    fid: delivery.fid,
    notification: { title: title.slice(0, 100), body: body.slice(0, 240) },
    data: {
      notificationId: delivery.notification_id,
      notificationType: delivery.notification_type,
      entityId: delivery.entity_id ?? "",
      communitySlug: communitySlug ?? "",
      actorUsername: actorUsername ?? "",
      deepLink,
    },
    android: {
      priority: "high" as const,
      notification: {
        channelId: "community_notifications",
        clickAction: "FLUTTER_NOTIFICATION_CLICK",
      },
    },
    apns: {
      payload: { aps: { sound: "default" } },
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
         pd.attempts
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
