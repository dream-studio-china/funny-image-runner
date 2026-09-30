import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { getPool } from "@/lib/db";

export const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "funny_image_runner_session";
const DEFAULT_SESSION_TTL_DAYS = 30;

function normalizeInviteCode(code: string): string {
  return code.normalize("NFKC").toUpperCase().replace(/[\s-]/g, "");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export async function redeemInvitation(code: string): Promise<{ userId: string; token: string; expiresAt: Date }> {
  const normalized = normalizeInviteCode(code);
  if (normalized.length < 12 || normalized.length > 64) throw new Error("INVITATION_INVALID");

  const pool = getPool();
  const connection = await pool.getConnection();
  const now = new Date();
  const ttlDays = Math.max(1, Math.min(90, Number(process.env.SESSION_TTL_DAYS) || DEFAULT_SESSION_TTL_DAYS));
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  const token = createSessionToken();
  const sessionId = randomUUID();

  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT i.id, i.user_id AS userId, i.redeemed_at AS redeemedAt, i.revoked_at AS revokedAt,
              i.expires_at AS inviteExpiresAt, u.disabled_at AS disabledAt
       FROM invitations i JOIN users u ON u.id = i.user_id
       WHERE i.code_hash = ? FOR UPDATE`,
      [hashSecret(normalized)],
    );
    const invitation = rows[0];
    const currentTime = new Date();
    if (!invitation || invitation.revokedAt || invitation.disabledAt || (invitation.inviteExpiresAt && new Date(invitation.inviteExpiresAt) <= currentTime)) {
      throw new Error("INVITATION_INVALID");
    }

    await connection.execute(
      "UPDATE invitations SET redeemed_at = COALESCE(redeemed_at, UTC_TIMESTAMP(3)) WHERE id = ? AND revoked_at IS NULL",
      [invitation.id],
    );

    await connection.execute(
      "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3), ?)",
      [sessionId, invitation.userId, hashSecret(token), expiresAt],
    );
    await connection.execute(
      "INSERT INTO audit_events (id, actor_type, actor_id, action, target_id, metadata, created_at) VALUES (?, 'user', ?, ?, ?, ?, UTC_TIMESTAMP(3))",
      [randomUUID(), invitation.userId, invitation.redeemedAt ? "invitation.reused" : "invitation.redeemed", invitation.id, JSON.stringify({ sessionId })],
    );
    await connection.commit();
    return { userId: invitation.userId as string, token, expiresAt };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getSessionUser(cookieHeader: string | null): Promise<{ id: string } | null> {
  const token = parseCookie(cookieHeader, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const [rows] = await getPool().execute<RowDataPacket[]>(
    `SELECT u.id
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3) AND u.disabled_at IS NULL
     LIMIT 1`,
    [hashSecret(token)],
  );
  return rows[0] ? { id: rows[0].id as string } : null;
}

export async function revokeSession(cookieHeader: string | null): Promise<void> {
  const token = parseCookie(cookieHeader, SESSION_COOKIE);
  if (!token || token.length > 128) return;
  await getPool().execute(
    "UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE token_hash = ? AND revoked_at IS NULL",
    [hashSecret(token)],
  );
}

export async function allowInvitationAttempt(key: string, maximum: number, windowMinutes: number): Promise<boolean> {
  const keyHash = hashSecret(key);
  await getPool().execute(
    `INSERT INTO auth_rate_limits (key_hash, attempts, reset_at)
     VALUES (?, 1, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MINUTE))
     ON DUPLICATE KEY UPDATE
       attempts = IF(reset_at <= UTC_TIMESTAMP(3), 1, attempts + 1),
       reset_at = IF(reset_at <= UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MINUTE), reset_at)`,
    [keyHash, windowMinutes, windowMinutes],
  );
  const [rows] = await getPool().execute<RowDataPacket[]>(
    "SELECT attempts FROM auth_rate_limits WHERE key_hash = ? LIMIT 1",
    [keyHash],
  );
  return Number(rows[0]?.attempts ?? maximum + 1) <= maximum;
}

export function sessionCookie(token: string, expiresAt: Date): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`;
}

export function clearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
