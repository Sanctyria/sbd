import { lookup } from "node:dns/promises";
import https from "node:https";

export interface LinkPreviewMetadata {
  title: string | null;
  description: string | null;
  domain: string;
  imageUrl: string | null;
  profile?: {
    displayName: string;
    username: string;
    avatarUrl: string | null;
    avatarColor: string | null;
    initials: string | null;
  };
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  const third = octets[2] ?? -1;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

async function publicIpv4(hostname: string): Promise<string | null> {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return isPublicIpv4(hostname) ? hostname : null;
  }
  if (hostname.includes(":")) return null;

  try {
    const addresses = await lookup(hostname, {
      family: 4,
      all: true,
      verbatim: true,
    });
    if (
      !addresses.length ||
      addresses.some(({ address }) => !isPublicIpv4(address))
    ) {
      return null;
    }
    return addresses[0]?.address ?? null;
  } catch {
    return null;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number(decimal)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexadecimal: string) =>
      String.fromCodePoint(parseInt(hexadecimal, 16)),
    )
    .trim();
}

function metaContent(html: string, key: string): string | null {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tagText = tag[0];
    if (!tagText) continue;
    const attributes = new Map<string, string>();
    for (const attribute of tagText.matchAll(
      /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    )) {
      const name = attribute[1];
      if (!name) continue;
      attributes.set(
        name.toLowerCase(),
        decodeHtml(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""),
      );
    }
    if (
      attributes.get("property")?.toLowerCase() === key ||
      attributes.get("name")?.toLowerCase() === key
    ) {
      return attributes.get("content") || null;
    }
  }
  return null;
}

function htmlTitle(html: string): string | null {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = match?.[1];
  return title ? decodeHtml(title.replace(/<[^>]*>/g, "")) : null;
}

async function requestHtml(
  url: URL,
  redirectCount = 0,
): Promise<{ html: string; url: URL }> {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    redirectCount > 3
  ) {
    throw new Error("Unsupported link-preview URL.");
  }

  const address = await publicIpv4(url.hostname);
  if (!address)
    throw new Error("The link-preview host is not publicly routable.");

  const response = await new Promise<{
    statusCode: number;
    location?: string;
    contentType?: string;
    html: string;
  }>((resolve, reject) => {
    const request = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: url.hostname,
        lookup: (_hostname, _options, callback) => callback(null, address, 4),
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "SanctyriaLinkPreview/1.0",
        },
      },
      (incoming) => {
        const statusCode = incoming.statusCode ?? 0;
        const location = incoming.headers.location;
        const contentType = incoming.headers["content-type"];
        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          incoming.resume();
          resolve({ statusCode, location, html: "" });
          return;
        }
        if (
          statusCode < 200 ||
          statusCode >= 300 ||
          typeof contentType !== "string" ||
          !/^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType)
        ) {
          incoming.resume();
          reject(new Error("The link does not serve an HTML page."));
          return;
        }

        const chunks: Buffer[] = [];
        let length = 0;
        incoming.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 512_000) {
            incoming.destroy(new Error("Link-preview page is too large."));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () =>
          resolve({
            statusCode,
            contentType,
            html: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        incoming.on("error", reject);
      },
    );
    request.setTimeout(4_000, () =>
      request.destroy(new Error("Link-preview request timed out.")),
    );
    request.on("error", reject);
    request.end();
  });

  if (response.location) {
    return requestHtml(new URL(response.location, url), redirectCount + 1);
  }
  return { html: response.html, url };
}

export async function fetchLinkPreview(url: URL): Promise<LinkPreviewMetadata> {
  const imageExtension = url.pathname.match(/\.(?:avif|gif|jpe?g|png|webp)$/i);
  if (imageExtension) {
    const address = await publicIpv4(url.hostname);
    if (!address)
      throw new Error("The link-preview host is not publicly routable.");
    return {
      title: decodeURIComponent(url.pathname.split("/").at(-1) ?? "Image"),
      description: null,
      domain: url.hostname,
      imageUrl: url.href,
    };
  }

  const { html, url: finalUrl } = await requestHtml(url);
  const rawImage =
    metaContent(html, "og:image") ??
    metaContent(html, "og:image:url") ??
    metaContent(html, "twitter:image");
  let imageUrl: string | null = null;
  if (rawImage) {
    try {
      const image = new URL(rawImage, finalUrl);
      if (image.protocol === "https:" && (await publicIpv4(image.hostname))) {
        imageUrl = image.href;
      }
    } catch {
      imageUrl = null;
    }
  }

  return {
    title:
      metaContent(html, "og:title") ??
      metaContent(html, "twitter:title") ??
      htmlTitle(html),
    description:
      metaContent(html, "og:description") ??
      metaContent(html, "twitter:description") ??
      metaContent(html, "description"),
    domain: finalUrl.hostname,
    imageUrl,
  };
}
