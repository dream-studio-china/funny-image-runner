import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { isAdminRequest } from "@/lib/admin-auth";
import { hashSecret } from "@/lib/auth";
import { encryptInvitationCode } from "@/lib/invitation-secrets";
import { isRecord, isSameOriginRequest, jsonResponse, readJson, validateUserId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type InvitationInput = {
  userId: string;
  batchId: string;
  ordinal: number;
  codeHash: string;
  codeCiphertext: string | null;
  expiresAt: Date | null;
};

function parseItem(value: unknown): InvitationInput | null {
  if (!isRecord(value) || !validateUserId(value.userId) ||
      typeof value.batchId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value.batchId) ||
      !Number.isSafeInteger(value.ordinal) || (value.ordinal as number) < 1 ||
      typeof value.codeHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.codeHash) ||
      (value.code !== undefined && typeof value.code !== "string")) return null;

  let codeCiphertext: string | null = null;
  if (typeof value.code === "string") {
    const normalizedCode = value.code.normalize("NFKC").toUpperCase().replace(/[\s-]/g, "");
    if (normalizedCode.length < 12 || !/^[0-9A-HJKMNP-TV-Z]+$/.test(normalizedCode)) return null;
    if (hashSecret(normalizedCode) !== value.codeHash.toLowerCase()) return null;
    codeCiphertext = encryptInvitationCode(value.code);
  }

  let expiresAt: Date | null = null;
  if (value.expiresAt !== undefined && value.expiresAt !== null) {
    if (typeof value.expiresAt !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value.expiresAt)) return null;
    expiresAt = new Date(value.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) return null;
  }
  return {
    userId: value.userId,
    batchId: value.batchId,
    ordinal: value.ordinal as number,
    codeHash: value.codeHash.toLowerCase(),
    codeCiphertext,
    expiresAt,
  };
}

export async function POST(request: Request): Promise<Response> {
  if (request.headers.has("cookie") && !isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }

  let body: unknown;
  try {
    body = await readJson(request, 64 * 1024);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message.toLowerCase() : "invalid_request" }, 400);
  }
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  let items: Array<InvitationInput | null>;
  try {
    items = body.items.map(parseItem);
  } catch (error) {
    console.error("Invitation encryption configuration error", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  if (items.some((item) => item === null)) return jsonResponse({ error: "invalid_invitation" }, 400);
  const parsedItems = items as InvitationInput[];
  const compoundKeys = new Set<string>();
  const codeHashes = new Set<string>();
  for (const item of parsedItems) {
    const compoundKey = `${item.batchId}:${item.ordinal}`;
    if (compoundKeys.has(compoundKey) || codeHashes.has(item.codeHash)) return jsonResponse({ error: "duplicate_item" }, 400);
    compoundKeys.add(compoundKey);
    codeHashes.add(item.codeHash);
  }

  let connection: PoolConnection | undefined;
  try {
    connection = await getPool().getConnection();
    await connection.beginTransaction();
    for (const item of parsedItems) {
      await connection.execute(
        "INSERT INTO users (id, created_at) VALUES (?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id = id",
        [item.userId],
      );
      const [rows] = await connection.execute<RowDataPacket[]>(
        "SELECT id, user_id AS userId, code_hash AS codeHash, code_ciphertext AS codeCiphertext, expires_at AS expiresAt FROM invitations WHERE batch_id = ? AND ordinal = ? FOR UPDATE",
        [item.batchId, item.ordinal],
      );
      if (rows[0]) {
        const old = rows[0];
        const sameExpiration = (old.expiresAt ? new Date(old.expiresAt).getTime() : null) === (item.expiresAt?.getTime() ?? null);
        if (old.userId !== item.userId || old.codeHash !== item.codeHash || !sameExpiration) {
          throw new Error("INVITATION_CONFLICT");
        }
        if (!old.codeCiphertext && item.codeCiphertext) {
          await connection.execute("UPDATE invitations SET code_ciphertext = ? WHERE id = ? AND code_ciphertext IS NULL", [item.codeCiphertext, old.id]);
        }
        continue;
      }
      await connection.execute(
        "INSERT INTO invitations (id, user_id, batch_id, ordinal, code_hash, created_at, expires_at, account_ttl_minutes, code_ciphertext) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), ?, 1440, ?)",
        [randomUUID(), item.userId, item.batchId, item.ordinal, item.codeHash, item.expiresAt, item.codeCiphertext],
      );
      await connection.execute(
        "INSERT INTO audit_events (id, actor_type, action, target_id, metadata, created_at) VALUES (?, 'admin', 'invitation.imported', ?, ?, UTC_TIMESTAMP(3))",
        [randomUUID(), item.userId, JSON.stringify({ batchId: item.batchId, ordinal: item.ordinal })],
      );
    }
    await connection.commit();
    return jsonResponse({ imported: parsedItems.length });
  } catch (error) {
    if (connection) await connection.rollback();
    if (error instanceof Error && error.message === "INVITATION_CONFLICT") return jsonResponse({ error: "invitation_conflict" }, 409);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
      return jsonResponse({ error: "invitation_conflict" }, 409);
    }
    console.error("Invitation import failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  } finally {
    connection?.release();
  }
}
