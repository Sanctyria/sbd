export function extractMentionUsernames(content: string): string[] {
  return [
    ...new Set(
      [...content.matchAll(/(?:^|[\s(])@([a-z0-9][a-z0-9_-]{2,29})\b/gi)].flatMap(
        (match) => (match[1] ? [match[1].toLowerCase()] : []),
      ),
    ),
  ];
}