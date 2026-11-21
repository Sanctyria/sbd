import type { Environment } from "../config/env.js";

export class AccountEmailUnavailableError extends Error {
  constructor() {
    super("Account email delivery is not configured.");
    this.name = "AccountEmailUnavailableError";
  }
}

export class AccountEmailDeliveryError extends Error {
  constructor() {
    super("Account email delivery failed.");
    this.name = "AccountEmailDeliveryError";
  }
}

export async function sendAccountEmail(
  config: Environment,
  to: string,
  purpose: "verify" | "password_reset",
  code: string,
): Promise<void> {
  if (!config.RESEND_API_KEY || !config.AUTH_EMAIL_FROM) {
    throw new AccountEmailUnavailableError();
  }
  const subject =
    purpose === "verify"
      ? "Verify your Sanctyria email"
      : "Reset your Sanctyria password";
  const action =
    purpose === "verify" ? "verify your email" : "reset your password";
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.AUTH_EMAIL_FROM,
        to: [to],
        subject,
        text: `Use this one-time code to ${action}: ${code}\n\nThis code expires in 20 minutes. If you did not request this, you can ignore this email.`,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AccountEmailDeliveryError();
  }
  if (!response.ok) throw new AccountEmailDeliveryError();
}
