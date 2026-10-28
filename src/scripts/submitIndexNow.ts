import "dotenv/config";
import { environment } from "../config/env.js";

const siteOrigin = "https://sanctyria.com";
const sitemapUrl = `${siteOrigin}/sitemap.xml`;
const maxUrlsPerRequest = 10_000;

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

async function main(): Promise<void> {
  const key = environment.INDEXNOW_KEY;
  if (!key) {
    throw new Error("Set INDEXNOW_KEY in the backend environment first.");
  }

  const keyResponse = await fetch(`${siteOrigin}/${key}.txt`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!keyResponse.ok || (await keyResponse.text()).trim() !== key) {
    throw new Error(
      "IndexNow key verification file is not publicly available at the canonical site.",
    );
  }

  const sitemapResponse = await fetch(sitemapUrl, {
    headers: { accept: "application/xml" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!sitemapResponse.ok) {
    throw new Error(`Could not load the production sitemap: HTTP ${sitemapResponse.status}.`);
  }
  const sitemap = await sitemapResponse.text();
  const urls = [
    ...new Set(
      [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => decodeXml(match[1] ?? "")),
    ),
  ];
  if (!urls.length) throw new Error("The production sitemap contains no URLs.");
  if (
    urls.some((url) => {
      try {
        return new URL(url).origin !== siteOrigin;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("The production sitemap contains an invalid or non-canonical URL.");
  }

  for (let offset = 0; offset < urls.length; offset += maxUrlsPerRequest) {
    const urlList = urls.slice(offset, offset + maxUrlsPerRequest);
    const response = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: "sanctyria.com",
        key,
        keyLocation: `${siteOrigin}/${key}.txt`,
        urlList,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(
        `IndexNow rejected a batch of ${urlList.length} sitemap URLs: HTTP ${response.status}.`,
      );
    }
    console.info(`IndexNow accepted ${urlList.length} sitemap URLs (HTTP ${response.status}).`);
  }
  console.info(`Initial IndexNow submission completed for ${urls.length} sitemap URLs.`);
}

main().catch((error: unknown) => {
  console.error("Initial IndexNow submission failed.", error);
  process.exitCode = 1;
});
