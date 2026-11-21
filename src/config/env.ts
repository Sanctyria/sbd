import "dotenv/config";
import { z } from "zod";

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    TRUST_PROXY: z
      .string()
      .default("127.0.0.1,::1")
      .transform((value) =>
        value
          .split(",")
          .map((address) => address.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().min(1))),
    SESSION_COOKIE_NAME: z.string().min(1).default("sanctyria_session"),
    SESSION_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
    RESEND_API_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().min(1).optional(),
    ),
    AUTH_EMAIL_FROM: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().email().optional(),
    ),
    FIREBASE_SERVICE_ACCOUNT_JSON: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    GOOGLE_APPLICATION_CREDENTIALS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    CLOUDINARY_CLOUD_NAME: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
    ),
    CLOUDINARY_API_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().min(1).max(100).optional(),
    ),
    CLOUDINARY_API_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().min(1).max(200).optional(),
    ),
    TURNSTILE_SITE_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    TURNSTILE_SECRET_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    STRIPE_SECRET_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    STRIPE_WEBHOOK_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    PAYPAL_CLIENT_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    PAYPAL_CLIENT_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    PAYPAL_WEBHOOK_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    PAYPAL_ENVIRONMENT: z.enum(["sandbox", "live"]).default("sandbox"),
    CRYPTO_WALLET_ADDRESS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().min(1).max(256).optional(),
    ),
    CRYPTO_WALLET_ASSET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().min(1).max(40).optional(),
    ),
    CRYPTO_WALLET_NETWORK: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().min(1).max(80).optional(),
    ),
    CASH_APP_TAG: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._-]{1,50}$/)
        .optional(),
    ),
    SENTRY_DSN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional(),
    ),
    INDEXNOW_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^[A-Za-z0-9-]{8,128}$/)
        .optional(),
    ),
    CORE_ADMIN_USER_IDS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().uuid())),
    CORE_SUPER_ADMIN_USER_IDS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().uuid())),
    DATABASE_URL: z.string().url(),
  })
  .superRefine((value, context) => {
    if (Boolean(value.RESEND_API_KEY) !== Boolean(value.AUTH_EMAIL_FROM)) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_EMAIL_FROM"],
        message:
          "Configure both the Resend API key and verified sender email to enable account recovery.",
      });
    }
    const cloudinaryCredentials = [
      value.CLOUDINARY_CLOUD_NAME,
      value.CLOUDINARY_API_KEY,
      value.CLOUDINARY_API_SECRET,
    ];
    if (
      cloudinaryCredentials.some(Boolean) &&
      !cloudinaryCredentials.every(Boolean)
    ) {
      context.addIssue({
        code: "custom",
        path: ["CLOUDINARY_API_SECRET"],
        message:
          "Configure the Cloudinary cloud name, API key, and API secret together.",
      });
    }

    const turnstileKeys = [
      value.TURNSTILE_SITE_KEY,
      value.TURNSTILE_SECRET_KEY,
    ];
    if (turnstileKeys.some(Boolean) && !turnstileKeys.every(Boolean)) {
      context.addIssue({
        code: "custom",
        path: ["TURNSTILE_SECRET_KEY"],
        message: "Configure the Turnstile site key and secret key together.",
      });
    }

    if (
      value.NODE_ENV === "production" &&
      (!value.TURNSTILE_SITE_KEY || !value.TURNSTILE_SECRET_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["TURNSTILE_SECRET_KEY"],
        message:
          "Turnstile site and secret keys must be configured in production.",
      });
    }

    const stripeCredentials = [
      value.STRIPE_SECRET_KEY,
      value.STRIPE_WEBHOOK_SECRET,
    ];
    if (stripeCredentials.some(Boolean) && !stripeCredentials.every(Boolean)) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_WEBHOOK_SECRET"],
        message:
          "Configure the Stripe API secret and webhook signing secret together.",
      });
    }

    const paypalCredentials = [
      value.PAYPAL_CLIENT_ID,
      value.PAYPAL_CLIENT_SECRET,
      value.PAYPAL_WEBHOOK_ID,
    ];
    if (paypalCredentials.some(Boolean) && !paypalCredentials.every(Boolean)) {
      context.addIssue({
        code: "custom",
        path: ["PAYPAL_WEBHOOK_ID"],
        message:
          "Configure the PayPal client ID, client secret, and webhook ID together.",
      });
    }

    const cryptoSettings = [
      value.CRYPTO_WALLET_ADDRESS,
      value.CRYPTO_WALLET_ASSET,
      value.CRYPTO_WALLET_NETWORK,
    ];
    if (cryptoSettings.some(Boolean) && !cryptoSettings.every(Boolean)) {
      context.addIssue({
        code: "custom",
        path: ["CRYPTO_WALLET_NETWORK"],
        message:
          "Configure the crypto wallet address, asset, and network together.",
      });
    }

    for (const id of value.CORE_SUPER_ADMIN_USER_IDS) {
      if (!value.CORE_ADMIN_USER_IDS.includes(id)) {
        context.addIssue({
          code: "custom",
          path: ["CORE_SUPER_ADMIN_USER_IDS"],
          message: "Super administrators must also be global administrators.",
        });
      }
    }
  });

export const environment = environmentSchema.parse(process.env);

export type Environment = z.infer<typeof environmentSchema>;
