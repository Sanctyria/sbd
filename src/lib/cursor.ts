import { z } from "zod";

const cursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
});

export interface PageCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
  ).toString("base64url");
}

export function decodeCursor(value?: string): PageCursor | null | undefined {
  if (!value) return undefined;

  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (!parsed.success) return null;
    return { createdAt: new Date(parsed.data.createdAt), id: parsed.data.id };
  } catch {
    return null;
  }
}
