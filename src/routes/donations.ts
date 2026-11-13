import { randomUUID } from "node:crypto";
import { normalizeIP } from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Environment } from "../config/env.js";
import { database } from "../db/client.js";
import { paymentWebhookEvents } from "../db/schema.js";
import { verifyStripeSignature } from "../lib/authSecurity.js";

const donationSchema = z.object({
  amount: z.number().int().min(1).max(5_000),
});

const stripeEventSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  data: z.object({
    object: z.object({
      id: z.string().optional(),
      payment_status: z.string().optional(),
      amount_total: z.number().int().positive().optional(),
      currency: z.string().length(3).optional(),
    }),
  }),
});

const paypalEventSchema = z
  .object({
    id: z.string().min(1).max(255),
    event_type: z.string().min(1).max(255),
    resource: z
      .object({
        amount: z
          .object({
            value: z.string().optional(),
            currency_code: z.string().length(3).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function isAllowedOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Environment,
): boolean {
  const origin = request.headers.origin;
  if (!origin || origin === config.WEB_ORIGIN) return true;
  reply.code(403).send({
    error: {
      code: "ORIGIN_NOT_ALLOWED",
      message: "Request origin is not allowed.",
    },
  });
  return false;
}

function checkoutIsConfigured(config: Environment): boolean {
  return Boolean(config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET);
}

function paypalIsConfigured(config: Environment): boolean {
  return Boolean(
    config.PAYPAL_CLIENT_ID &&
    config.PAYPAL_CLIENT_SECRET &&
    config.PAYPAL_WEBHOOK_ID,
  );
}

function paypalApiOrigin(config: Environment): string {
  return config.PAYPAL_ENVIRONMENT === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

async function getPayPalAccessToken(config: Environment): Promise<string> {
  if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) {
    throw new Error("PayPal credentials are not configured.");
  }
  const response = await fetch(`${paypalApiOrigin(config)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(
        `${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`,
      ).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await response.json().catch(() => null)) as {
    access_token?: string;
  } | null;
  if (!response.ok || !result?.access_token) {
    throw new Error("PayPal authentication failed.");
  }
  return result.access_token;
}

function stripeSuccessEvent(
  event: z.infer<typeof stripeEventSchema>,
): { amountMinor: number; currency: string } | null {
  if (
    ![
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ].includes(event.type) ||
    event.data.object.payment_status !== "paid" ||
    !event.data.object.amount_total ||
    event.data.object.amount_total > 500_000 ||
    event.data.object.currency?.toUpperCase() !== "USD"
  ) {
    return null;
  }
  return {
    amountMinor: event.data.object.amount_total,
    currency: event.data.object.currency.toUpperCase(),
  };
}

function paypalSuccessEvent(
  event: z.infer<typeof paypalEventSchema>,
): { amountMinor: number; currency: string } | null {
  if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") return null;
  const amount = event.resource?.amount;
  const value = Number(amount?.value);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 5_000 ||
    !Number.isSafeInteger(Math.round(value * 100)) ||
    amount?.currency_code?.toUpperCase() !== "USD"
  ) {
    return null;
  }
  return {
    amountMinor: Math.round(value * 100),
    currency: amount.currency_code.toUpperCase(),
  };
}

async function recordVerifiedPayment(
  provider: "stripe" | "paypal",
  externalEventId: string,
  eventType: string,
  payment: { amountMinor: number; currency: string } | null,
): Promise<void> {
  if (!payment) return;
  await database
    .insert(paymentWebhookEvents)
    .values({
      provider,
      externalEventId,
      eventType,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    })
    .onConflictDoNothing({
      target: [
        paymentWebhookEvents.provider,
        paymentWebhookEvents.externalEventId,
      ],
    });
}

export async function donationRoutes(
  app: FastifyInstance,
  config: Environment,
): Promise<void> {
  app.get("/api/v1/donations/options", async () => ({
    stripe: checkoutIsConfigured(config),
    paypal: paypalIsConfigured(config),
    cashAppTag: config.CASH_APP_TAG ?? null,
    cryptoWallet:
      config.CRYPTO_WALLET_ADDRESS &&
      config.CRYPTO_WALLET_ASSET &&
      config.CRYPTO_WALLET_NETWORK
        ? {
            address: config.CRYPTO_WALLET_ADDRESS,
            asset: config.CRYPTO_WALLET_ASSET,
            network: config.CRYPTO_WALLET_NETWORK,
          }
        : null,
  }));

  app.post(
    "/api/v1/donations/stripe/checkout",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 hour",
          keyGenerator: (request) => normalizeIP(request.ip),
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request, reply, config)) return;
      const parsed = donationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "Choose an amount between $1 and $5,000 USD.",
          },
        });
      }
      if (!checkoutIsConfigured(config) || !config.STRIPE_SECRET_KEY) {
        return reply.code(503).send({
          error: {
            code: "PAYMENT_METHOD_UNAVAILABLE",
            message: "Stripe donations are not configured yet.",
          },
        });
      }

      const form = new URLSearchParams({
        mode: "payment",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(
          parsed.data.amount * 100,
        ),
        "line_items[0][price_data][product_data][name]":
          "Sanctyria community support",
        "line_items[0][quantity]": "1",
        success_url: `${config.WEB_ORIGIN}/donate?status=return`,
        cancel_url: `${config.WEB_ORIGIN}/donate?status=cancelled`,
      });

      let response: Response;
      try {
        response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.STRIPE_SECRET_KEY}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": randomUUID(),
          },
          body: form,
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        request.log.error({ err: error }, "Stripe checkout request failed");
        return reply.code(502).send({
          error: {
            code: "PAYMENT_PROVIDER_UNAVAILABLE",
            message: "Stripe could not start checkout. Try again shortly.",
          },
        });
      }
      const result = (await response.json().catch(() => null)) as {
        url?: string;
      } | null;
      if (!response.ok || !result?.url) {
        request.log.error(
          { statusCode: response.status },
          "Stripe checkout session was not created",
        );
        return reply.code(502).send({
          error: {
            code: "PAYMENT_PROVIDER_ERROR",
            message: "Stripe could not start checkout. Try again shortly.",
          },
        });
      }
      const checkoutUrl = new URL(result.url);
      if (
        checkoutUrl.protocol !== "https:" ||
        checkoutUrl.hostname !== "checkout.stripe.com"
      ) {
        request.log.error("Stripe returned an unexpected checkout URL");
        return reply.code(502).send({
          error: {
            code: "PAYMENT_PROVIDER_ERROR",
            message: "Stripe returned an invalid checkout destination.",
          },
        });
      }
      return { url: checkoutUrl.toString() };
    },
  );

  app.post(
    "/api/v1/donations/paypal/order",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 hour",
          keyGenerator: (request) => normalizeIP(request.ip),
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request, reply, config)) return;
      const parsed = donationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "Choose an amount between $1 and $5,000 USD.",
          },
        });
      }
      if (!paypalIsConfigured(config)) {
        return reply.code(503).send({
          error: {
            code: "PAYMENT_METHOD_UNAVAILABLE",
            message: "PayPal donations are not configured yet.",
          },
        });
      }

      try {
        const accessToken = await getPayPalAccessToken(config);
        const response = await fetch(
          `${paypalApiOrigin(config)}/v2/checkout/orders`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
              "paypal-request-id": randomUUID(),
            },
            body: JSON.stringify({
              intent: "CAPTURE",
              purchase_units: [
                {
                  description: "Sanctyria community support",
                  amount: {
                    currency_code: "USD",
                    value: parsed.data.amount.toFixed(2),
                  },
                },
              ],
              application_context: {
                brand_name: "Sanctyria",
                user_action: "PAY_NOW",
                return_url: `${config.WEB_ORIGIN}/donate?status=paypal-return`,
                cancel_url: `${config.WEB_ORIGIN}/donate?status=cancelled`,
              },
            }),
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          },
        );
        const result = (await response.json().catch(() => null)) as {
          links?: { rel?: string; href?: string }[];
        } | null;
        const approvalUrl = result?.links?.find(
          (link) => link.rel === "approve",
        )?.href;
        if (!response.ok || !approvalUrl) {
          request.log.error(
            { statusCode: response.status },
            "PayPal order was not created",
          );
          return reply.code(502).send({
            error: {
              code: "PAYMENT_PROVIDER_ERROR",
              message: "PayPal could not start checkout. Try again shortly.",
            },
          });
        }
        const checkoutUrl = new URL(approvalUrl);
        const allowedHost =
          config.PAYPAL_ENVIRONMENT === "live"
            ? "www.paypal.com"
            : "www.sandbox.paypal.com";
        if (
          checkoutUrl.protocol !== "https:" ||
          checkoutUrl.hostname !== allowedHost
        ) {
          request.log.error("PayPal returned an unexpected approval URL");
          return reply.code(502).send({
            error: {
              code: "PAYMENT_PROVIDER_ERROR",
              message: "PayPal returned an invalid checkout destination.",
            },
          });
        }
        return { url: checkoutUrl.toString() };
      } catch (error) {
        request.log.error({ err: error }, "PayPal checkout request failed");
        return reply.code(502).send({
          error: {
            code: "PAYMENT_PROVIDER_UNAVAILABLE",
            message: "PayPal could not start checkout. Try again shortly.",
          },
        });
      }
    },
  );

  app.post(
    "/api/v1/donations/paypal/capture",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 hour",
          keyGenerator: (request) => normalizeIP(request.ip),
        },
      },
    },
    async (request, reply) => {
      if (!isAllowedOrigin(request, reply, config)) return;
      const parsed = z
        .object({ orderId: z.string().regex(/^[A-Z0-9-]{10,64}$/) })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "The PayPal order reference is invalid.",
          },
        });
      }
      if (!paypalIsConfigured(config)) {
        return reply.code(503).send({
          error: {
            code: "PAYMENT_METHOD_UNAVAILABLE",
            message: "PayPal donations are not configured yet.",
          },
        });
      }

      try {
        const accessToken = await getPayPalAccessToken(config);
        const response = await fetch(
          `${paypalApiOrigin(config)}/v2/checkout/orders/${encodeURIComponent(parsed.data.orderId)}/capture`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
              "paypal-request-id": parsed.data.orderId,
            },
            body: "{}",
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          },
        );
        const result = (await response.json().catch(() => null)) as {
          status?: string;
        } | null;
        if (!response.ok || result?.status !== "COMPLETED") {
          request.log.error(
            { statusCode: response.status },
            "PayPal order capture did not complete",
          );
          return reply.code(502).send({
            error: {
              code: "PAYMENT_PROVIDER_ERROR",
              message: "PayPal could not confirm the payment. Contact support.",
            },
          });
        }
        return { status: "completed" };
      } catch (error) {
        request.log.error({ err: error }, "PayPal order capture failed");
        return reply.code(502).send({
          error: {
            code: "PAYMENT_PROVIDER_UNAVAILABLE",
            message: "PayPal could not confirm the payment. Try again shortly.",
          },
        });
      }
    },
  );

  app.post("/api/v1/webhooks/stripe", async (request, reply) => {
    if (!config.STRIPE_WEBHOOK_SECRET) {
      return reply.code(503).send({
        error: {
          code: "WEBHOOK_NOT_CONFIGURED",
          message: "The Stripe webhook is not configured.",
        },
      });
    }
    if (
      !Buffer.isBuffer(request.rawBody) ||
      !verifyStripeSignature(
        request.rawBody,
        typeof request.headers["stripe-signature"] === "string"
          ? request.headers["stripe-signature"]
          : undefined,
        config.STRIPE_WEBHOOK_SECRET,
      )
    ) {
      return reply.code(400).send({
        error: {
          code: "INVALID_WEBHOOK_SIGNATURE",
          message: "The webhook signature is invalid.",
        },
      });
    }

    const parsed = stripeEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "INVALID_WEBHOOK",
          message: "The webhook payload is invalid.",
        },
      });
    }
    const payment = stripeSuccessEvent(parsed.data);
    if (payment) {
      await recordVerifiedPayment(
        "stripe",
        parsed.data.id,
        parsed.data.type,
        payment,
      );
    }
    return reply.code(200).send({ received: true });
  });

  app.post("/api/v1/webhooks/paypal", async (request, reply) => {
    if (!paypalIsConfigured(config)) {
      return reply.code(503).send({
        error: {
          code: "WEBHOOK_NOT_CONFIGURED",
          message: "The PayPal webhook is not configured.",
        },
      });
    }
    const parsed = paypalEventSchema.safeParse(request.body);
    const transmissionId = request.headers["paypal-transmission-id"];
    const transmissionTime = request.headers["paypal-transmission-time"];
    const certificateUrl = request.headers["paypal-cert-url"];
    const authAlgorithm = request.headers["paypal-auth-algo"];
    const transmissionSignature = request.headers["paypal-transmission-sig"];
    if (
      !parsed.success ||
      typeof transmissionId !== "string" ||
      typeof transmissionTime !== "string" ||
      typeof certificateUrl !== "string" ||
      typeof authAlgorithm !== "string" ||
      typeof transmissionSignature !== "string"
    ) {
      return reply.code(400).send({
        error: {
          code: "INVALID_WEBHOOK",
          message: "The webhook payload or signature headers are invalid.",
        },
      });
    }

    try {
      const accessToken = await getPayPalAccessToken(config);
      const verificationResponse = await fetch(
        `${paypalApiOrigin(config)}/v1/notifications/verify-webhook-signature`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            auth_algo: authAlgorithm,
            cert_url: certificateUrl,
            transmission_id: transmissionId,
            transmission_sig: transmissionSignature,
            transmission_time: transmissionTime,
            webhook_id: config.PAYPAL_WEBHOOK_ID,
            webhook_event: parsed.data,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      const verification = (await verificationResponse
        .json()
        .catch(() => null)) as {
        verification_status?: string;
      } | null;
      if (!verificationResponse.ok) {
        request.log.error(
          { statusCode: verificationResponse.status },
          "PayPal webhook verification request failed",
        );
        return reply.code(502).send({
          error: {
            code: "WEBHOOK_VERIFICATION_UNAVAILABLE",
            message: "The webhook could not be verified right now.",
          },
        });
      }
      if (verification?.verification_status !== "SUCCESS") {
        return reply.code(400).send({
          error: {
            code: "INVALID_WEBHOOK_SIGNATURE",
            message: "The webhook signature is invalid.",
          },
        });
      }

      await recordVerifiedPayment(
        "paypal",
        parsed.data.id,
        parsed.data.event_type,
        paypalSuccessEvent(parsed.data),
      );
      return reply.code(200).send({ received: true });
    } catch (error) {
      request.log.error({ err: error }, "PayPal webhook verification failed");
      return reply.code(502).send({
        error: {
          code: "WEBHOOK_VERIFICATION_UNAVAILABLE",
          message: "The webhook could not be verified right now.",
        },
      });
    }
  });
}
