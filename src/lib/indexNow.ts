import type { FastifyBaseLogger } from "fastify";

const siteOrigin = "https://sanctyria.com";
const indexNowEndpoint = "https://api.indexnow.org/indexnow";
const maxUrlsPerRequest = 10_000;

export function indexNowPageUrl(path: string): string {
  return new URL(path, siteOrigin).toString();
}

export function notifyIndexNow(
  urls: string[],
  key: string | undefined,
  log: Pick<FastifyBaseLogger, "warn">,
  production: boolean,
): void {
  if (!production || !key) return;
  void submitIndexNow(urls, key, log);
}

export async function submitIndexNow(
  urls: string[],
  key: string,
  log: Pick<FastifyBaseLogger, "warn">,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  const uniqueUrls = [...new Set(urls)];
  const validUrls = uniqueUrls.filter((url) => {
    try {
      return new URL(url).origin === siteOrigin;
    } catch {
      return false;
    }
  });
  if (validUrls.length !== uniqueUrls.length) {
    log.warn(
      { rejectedCount: uniqueUrls.length - validUrls.length },
      "IndexNow skipped non-canonical URLs",
    );
  }
  if (!validUrls.length) return;

  for (let offset = 0; offset < validUrls.length; offset += maxUrlsPerRequest) {
    const urlList = validUrls.slice(offset, offset + maxUrlsPerRequest);
    try {
      const response = await fetcher(indexNowEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          host: "sanctyria.com",
          key,
          keyLocation: `${siteOrigin}/${key}.txt`,
          urlList,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        log.warn(
          { statusCode: response.status, urlCount: urlList.length },
          "IndexNow rejected URL notifications",
        );
      }
    } catch (error) {
      log.warn(
        { err: error, urlCount: urlList.length },
        "IndexNow URL notification request failed",
      );
    }
  }
}
