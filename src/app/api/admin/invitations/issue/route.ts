import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { isAdminRequest } from "@/lib/admin-auth";
import { isRecord, isSameOriginRequest, jsonResponse, readJson, validateUserId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SOURCE = "taobao";

type IssuedInvitation = {
  id: string;
  userId: string;
  codeHash: string;
  codeCiphertext: string | null;
  expiresAt: Date | string | null;
  revokedAt: Date | string | null;
};

function encryptionKey(): Buffer {
  const encoded = process.env.INVITATION_ENCRYPTION_KEY;
  if (!encoded) throw new Error("INVITATION_ENCRYPTION_KEY_MISSING");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("INVITATION_ENCRYPTION_KEY_INVALID");
  return key;
}

function encryptCode(code: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptCode(value: string | null): string {
  if (!value) throw new Error("INVITATION_CIPHER_NOT_AVAILABLE");
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("INVITATION_CIPHER_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

function makeCode(bytes: Buffer): string {
  let buffer = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += CODE_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits) encoded += CODE_ALPHABET[(buffer << (5 - bits)) & 31];
  return encoded.match(/.{1,5}/g)?.join("-") ?? "";
}

function normalizeCode(code: string): string {
  return code.normalize("NFKC").toUpperCase().replace(/[\s-]/g, "");
}

function linkFor(code: string): string {
  const configuredBase = process.env.APP_BASE_URL;
  if (!configuredBase) throw new Error("APP_BASE_URL_MISSING");
  const base = new URL(configuredBase);
  if (process.env.NODE_ENV === "production" && base.protocol !== "https:") throw new Error("APP_BASE_URL_MUST_USE_HTTPS");
  base.pathname = "/";
  base.search = "";
  base.hash = new URLSearchParams({ invite: code }).toString();
  return base.toString();
}

function validateLinkConfiguration(): void {
  const configuredBase = process.env.APP_BASE_URL;
  if (!configuredBase) throw new Error("APP_BASE_URL_MISSING");
  const base = new URL(configuredBase);
  if (process.env.NODE_ENV === "production" && base.protocol !== "https:") throw new Error("APP_BASE_URL_MUST_USE_HTTPS");
}

function inviteTtlDays(): number {
  const configured = Number(process.env.INVITATION_TTL_DAYS ?? 30);
  if (!Number.isInteger(configured) || configured < 1 || configured > 365) throw new Error("INVITATION_TTL_DAYS_INVALID");
  return configured;
}

function validateRequest(body: unknown): { orderRef: string; userId: string; sourceRef: string } | null {
  if (!isRecord(body) || typeof body.orderRef !== "string" || body.orderRef.trim().length < 1 || body.orderRef.length > 256) return null;
  if (/[\u0000-\u001f\u007f]/.test(body.orderRef)) return null;

  const orderRef = body.orderRef.trim();
  if (body.userId !== undefined && !validateUserId(body.userId)) return null;
  if (body.customerRef !== undefined && (typeof body.customerRef !== "string" || body.customerRef.trim().length < 1 || body.customerRef.length > 256)) return null;

  const customerRef = typeof body.customerRef === "string" ? body.customerRef.trim() : orderRef;
  const userId = typeof body.userId === "string"
    ? body.userId
    : `taobao_${createHash("sha256").update(customerRef).digest("hex").slice(0, 24)}`;
  const sourceRef = createHash("sha256").update(`${SOURCE}:${orderRef}`).digest("hex");
  return { orderRef, userId, sourceRef };
}

async function findIssuedInvitation(connection: PoolConnection, sourceRef: string): Promise<IssuedInvitation | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id, user_id AS userId, code_hash AS codeHash, code_ciphertext AS codeCiphertext,
            expires_at AS expiresAt, revoked_at AS revokedAt
     FROM invitations WHERE issue_source = ? AND source_ref = ? FOR UPDATE`,
    [SOURCE, sourceRef],
  );
  return (rows[0] as IssuedInvitation | undefined) ?? null;
}

function issueResponse(invitation: IssuedInvitation, idempotent: boolean): Response {
  const code = decryptCode(invitation.codeCiphertext);
  const expiresAt = invitation.expiresAt ? new Date(invitation.expiresAt).toISOString() : null;
  return jsonResponse({
    userId: invitation.userId,
    invitationId: invitation.id,
    inviteUrl: linkFor(code),
    expiresAt,
    idempotent,
  }, idempotent ? 200 : 201);
}

export async function POST(request: Request): Promise<Response> {
  if (request.headers.has("cookie") && !isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }

  let requestData: ReturnType<typeof validateRequest>;
  try {
    requestData = validateRequest(await readJson(request, 8192));
  } catch (error) {
    const status = error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 400;
    return jsonResponse({ error: status === 413 ? "body_too_large" : "invalid_json" }, status);
  }
  if (!requestData) return jsonResponse({ error: "invalid_request" }, 400);

  let ttlDays: number;
  try {
    // Fail before writing an invitation if delivery configuration is incomplete.
    encryptionKey();
    validateLinkConfiguration();
    ttlDays = inviteTtlDays();
  } catch (error) {
    console.error("Invitation issuance configuration error", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }

  const connection = await getPool().getConnection().catch((error: unknown) => {
    console.error("Invitation issuance database unavailable", error instanceof Error ? error.message : "unknown error");
    return null;
  });
  if (!connection) return jsonResponse({ error: "service_unavailable" }, 503);

  try {
    await connection.beginTransaction();
    const existing = await findIssuedInvitation(connection, requestData.sourceRef);
    if (existing) {
      if (existing.userId !== requestData.userId) {
        await connection.rollback();
        return jsonResponse({ error: "order_conflict" }, 409);
      }
      if (existing.revokedAt) {
        await connection.rollback();
        return jsonResponse({ error: "invitation_revoked" }, 409);
      }
      await connection.commit();
      return issueResponse(existing, true);
    }

    await connection.execute(
      "INSERT INTO users (id, created_at) VALUES (?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id = id",
      [requestData.userId],
    );
    const rawCode = makeCode(randomBytes(20));
    const normalizedCode = normalizeCode(rawCode);
    const invitation: IssuedInvitation = {
      id: randomUUID(),
      userId: requestData.userId,
      codeHash: createHash("sha256").update(normalizedCode).digest("hex"),
      codeCiphertext: encryptCode(rawCode),
      expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
      revokedAt: null,
    };
    const batchId = `${SOURCE}-${requestData.sourceRef.slice(0, 48)}`;
    await connection.execute(
      `INSERT INTO invitations
       (id, user_id, batch_id, ordinal, code_hash, created_at, expires_at, issue_source, source_ref, code_ciphertext)
       VALUES (?, ?, ?, 1, ?, UTC_TIMESTAMP(3), ?, ?, ?, ?)`,
      [invitation.id, invitation.userId, batchId, invitation.codeHash, invitation.expiresAt, SOURCE, requestData.sourceRef, invitation.codeCiphertext],
    );
    await connection.execute(
      "INSERT INTO audit_events (id, actor_type, action, target_id, metadata, created_at) VALUES (?, 'admin', 'invitation.issued', ?, ?, UTC_TIMESTAMP(3))",
      [randomUUID(), invitation.id, JSON.stringify({ source: SOURCE, sourceRefHash: requestData.sourceRef })],
    );
    await connection.commit();
    return issueResponse(invitation, false);
  } catch (error) {
    await connection.rollback();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
      try {
        const existing = await findIssuedInvitation(connection, requestData.sourceRef);
        if (existing && existing.userId === requestData.userId) {
          await connection.commit();
          return issueResponse(existing, true);
        }
      } catch {
        await connection.rollback();
      }
      return jsonResponse({ error: "order_conflict" }, 409);
    }
    console.error("Invitation issuance failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  } finally {
    connection.release();
  }
}
