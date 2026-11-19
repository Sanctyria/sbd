import { createHash } from "node:crypto";
import type { Environment } from "../config/env.js";

export type CloudinaryConfig = Pick<
  Environment,
  "CLOUDINARY_CLOUD_NAME" | "CLOUDINARY_API_KEY" | "CLOUDINARY_API_SECRET"
>;

export type CloudinaryResourceType = "image" | "video";

export function isCloudinaryConfigured(
  config: CloudinaryConfig,
): config is CloudinaryConfig & {
  CLOUDINARY_CLOUD_NAME: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;
} {
  return Boolean(
    config.CLOUDINARY_CLOUD_NAME &&
      config.CLOUDINARY_API_KEY &&
      config.CLOUDINARY_API_SECRET,
  );
}

export function cloudinarySignature(
  parameters: Record<string, string | number | boolean>,
  apiSecret: string,
): string {
  const canonicalParameters = Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
  return createHash("sha1")
    .update(`${canonicalParameters}${apiSecret}`)
    .digest("hex");
}

export function cloudinaryPublicIdFromUrl(
  value: string,
  cloudName: string,
  expectedFolder: string,
): { publicId: string; resourceType: CloudinaryResourceType } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com") {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments[0] !== cloudName ||
    segments[2] !== "upload" ||
    (segments[1] !== "image" && segments[1] !== "video")
  ) {
    return null;
  }
  const resourceType = segments[1];
  const assetSegments = segments.slice(3);
  if (/^v\d+$/.test(assetSegments[0] ?? "")) assetSegments.shift();
  const lastSegment = assetSegments.at(-1);
  if (!lastSegment) return null;
  assetSegments[assetSegments.length - 1] = lastSegment.replace(
    /\.[a-zA-Z0-9]+$/,
    "",
  );
  const publicId = assetSegments.join("/");
  if (!publicId.startsWith(`${expectedFolder}/`)) return null;
  return { publicId, resourceType };
}

export function isAudioCloudinaryUploadFromFolder(
  value: string | null | undefined,
  cloudName: string | undefined,
  expectedFolder: string,
): boolean {
  if (!value || !cloudName) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  const format = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return (
    ["mp3", "wav", "aac", "m4a", "mp4", "ogg", "flac"].includes(format ?? "") &&
    cloudinaryPublicIdFromUrl(value, cloudName, expectedFolder)?.resourceType ===
      "video"
  );
}

export async function destroyCloudinaryAsset(
  value: string | null | undefined,
  expectedFolder: string,
  config: CloudinaryConfig,
): Promise<boolean> {
  if (!value || !isCloudinaryConfigured(config)) return false;
  const asset = cloudinaryPublicIdFromUrl(
    value,
    config.CLOUDINARY_CLOUD_NAME,
    expectedFolder,
  );
  if (!asset) return false;

  const timestamp = Math.floor(Date.now() / 1000);
  const parameters = { public_id: asset.publicId, timestamp };
  const form = new URLSearchParams({
    ...Object.fromEntries(
      Object.entries(parameters).map(([key, parameter]) => [
        key,
        String(parameter),
      ]),
    ),
    api_key: config.CLOUDINARY_API_KEY,
    signature: cloudinarySignature(parameters, config.CLOUDINARY_API_SECRET),
  });
  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(
      config.CLOUDINARY_CLOUD_NAME,
    )}/${asset.resourceType}/destroy`,
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(10_000),
    },
  );
  const payload = (await response.json()) as { result?: unknown };
  if (
    !response.ok ||
    (payload.result !== "ok" && payload.result !== "not found")
  ) {
    throw new Error("Cloudinary asset cleanup failed.");
  }
  return payload.result === "ok";
}
