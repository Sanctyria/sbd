export function containsEveryoneMention(body: string): boolean {
  return /(?:^|[\s(])@everyone\b/i.test(body);
}

export function canUseEveryoneMention(input: {
  userId: string;
  creatorId: string | null;
  role: string;
}): boolean {
  return input.userId === input.creatorId || input.role === "owner";
}

export function chatAuthorRole(input: {
  userId: string;
  creatorId: string | null;
  role: string | null | undefined;
}): "owner" | "moderator" | "member" {
  if (input.userId === input.creatorId || input.role === "owner") return "owner";
  return input.role === "moderator" ? "moderator" : "member";
}
