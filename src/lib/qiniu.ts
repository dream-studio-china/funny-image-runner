import "server-only";
import { createHmac } from "node:crypto";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

type QiniuConfig = {
  accessKey: string;
  secretKey: string;
  bucket: string;
  uploadUrl: string;
  privateDomain: string;
};

function config(): QiniuConfig {
  const { QINIU_ACCESS_KEY, QINIU_SECRET_KEY, QINIU_BUCKET, QINIU_UPLOAD_URL, QINIU_PRIVATE_DOMAIN } = process.env;
  if (!QINIU_ACCESS_KEY || !QINIU_SECRET_KEY || !QINIU_BUCKET || !QINIU_UPLOAD_URL || !QINIU_PRIVATE_DOMAIN) {
    throw new Error("QINIU_CONFIGURATION_MISSING");
  }
  const uploadUrl = new URL(QINIU_UPLOAD_URL);
  const privateDomain = new URL(QINIU_PRIVATE_DOMAIN);
  if (uploadUrl.protocol !== "https:" || privateDomain.protocol !== "https:") {
    throw new Error("QINIU_URLS_MUST_USE_HTTPS");
  }
  return {
    accessKey: QINIU_ACCESS_KEY,
    secretKey: QINIU_SECRET_KEY,
    bucket: QINIU_BUCKET,
    uploadUrl: uploadUrl.toString(),
    privateDomain: privateDomain.origin,
  };
}

function urlSafeBase64(value: Buffer | string): string {
  return Buffer.isBuffer(value)
    ? value.toString("base64").replace(/\//g, "_").replace(/\+/g, "-")
    : Buffer.from(value).toString("base64").replace(/\//g, "_").replace(/\+/g, "-");
}

function signature(secret: string, input: string): string {
  return urlSafeBase64(createHmac("sha1", secret).update(input).digest());
}

export function createUploadCredential(key: string, maxBytes = MAX_UPLOAD_BYTES, insertOnly = true): { uploadUrl: string; uploadToken: string; expiresAt: Date } {
  const settings = config();
  const expiresInSeconds = 10 * 60;
  const policy = {
    scope: `${settings.bucket}:${key}`,
    deadline: Math.floor(Date.now() / 1000) + expiresInSeconds,
    ...(insertOnly ? { insertOnly: 1 } : {}),
    fsizeLimit: maxBytes,
    mimeLimit: ALLOWED_IMAGE_TYPES.join(";"),
  };
  const encodedPolicy = urlSafeBase64(JSON.stringify(policy));
  const policySignature = signature(settings.secretKey, encodedPolicy);
  return {
    uploadUrl: settings.uploadUrl,
    uploadToken: `${settings.accessKey}:${policySignature}:${encodedPolicy}`,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
  };
}

export async function verifyUploadedObject(key: string, expectedSize: number, expectedContentType: string): Promise<void> {
  const settings = config();
  const entry = urlSafeBase64(`${settings.bucket}:${key}`);
  const path = `/stat/${entry}`;
  const response = await fetch(`https://rs.qiniu.com${path}`, {
    headers: { authorization: `QBox ${settings.accessKey}:${signature(settings.secretKey, `${path}\n`)}` },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (response.status === 612 || response.status === 404) throw new Error("QINIU_OBJECT_NOT_FOUND");
  if (!response.ok) throw new Error("QINIU_STAT_FAILED");
  const object = await response.json() as { fsize?: number; mimeType?: string };
  if (object.fsize !== expectedSize || object.fsize > MAX_UPLOAD_BYTES || object.mimeType !== expectedContentType) {
    throw new Error("QINIU_OBJECT_MISMATCH");
  }
}

export function createPrivateDownloadUrl(key: string, ttlSeconds = 300): string {
  const settings = config();
  const deadline = Math.floor(Date.now() / 1000) + ttlSeconds;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const unsignedUrl = `${settings.privateDomain}/${encodedKey}?e=${deadline}`;
  const downloadToken = `${settings.accessKey}:${signature(settings.secretKey, unsignedUrl)}`;
  return `${unsignedUrl}&token=${downloadToken}`;
}

export function isAllowedImageType(value: string): value is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(value);
}
