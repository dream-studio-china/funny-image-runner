import "server-only";
import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { hashSecret, parseCookie, safeEqual } from "@/lib/auth";

export const ADMIN_SESSION_COOKIE = "funny_image_runner_admin_session";
export const ADMIN_SESSION_TTL_HOURS = 8;

export async function isAdminRequest(request: Request): Promise<boolean> {
  const expected = process.env.ADMIN_API_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  if (expected && authorization.startsWith("Bearer ") && safeEqual(authorization.slice(7), expected)) return true;

  const token = parseCookie(request.headers.get("cookie"), ADMIN_SESSION_COOKIE);
  if (!token || token.length > 128) return false;
  const [rows] = await getPool().execute<RowDataPacket[]>(
    `SELECT id FROM admin_sessions
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)
     LIMIT 1`,
    [hashSecret(token)],
  );
  return Boolean(rows[0]);
}

export function newAdminSession() {
  const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  return {
    id: randomUUID(),
    token,
    tokenHash: hashSecret(token),
    expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000),
  };
}

export function adminSessionCookie(token: string, expiresAt: Date): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${expiresAt.toUTCString()}${secure}`;
}

export function clearAdminSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export async function revokeAdminSession(cookieHeader: string | null): Promise<void> {
  const token = parseCookie(cookieHeader, ADMIN_SESSION_COOKIE);
  if (!token || token.length > 128) return;
  await getPool().execute(
    "UPDATE admin_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE token_hash = ? AND revoked_at IS NULL",
    [hashSecret(token)],
  );
}
