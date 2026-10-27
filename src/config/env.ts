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
    SESSION_COOKIE_NAME: z.string().min(1).default("sanctyria_session"),
    SESSION_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
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
