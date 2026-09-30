import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey(): Buffer {
  const encoded = process.env.INVITATION_ENCRYPTION_KEY;
  if (!encoded) throw new Error("INVITATION_ENCRYPTION_KEY_MISSING");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("INVITATION_ENCRYPTION_KEY_INVALID");
  return key;
}

export function encryptInvitationCode(code: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptInvitationCode(value: string): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("INVITATION_CIPHER_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function createInvitationUrl(code: string): string {
  const configuredBase = process.env.APP_BASE_URL;
  if (!configuredBase) throw new Error("APP_BASE_URL_MISSING");
  const base = new URL(configuredBase);
  if (process.env.NODE_ENV === "production" && base.protocol !== "https:") throw new Error("APP_BASE_URL_MUST_USE_HTTPS");
  base.pathname = "/";
  base.search = "";
  base.hash = new URLSearchParams({ invite: code }).toString();
  return base.toString();
}
