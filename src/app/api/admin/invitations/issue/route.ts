import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { isAdminRequest } from "@/lib/admin-auth";
import { createInvitationUrl, decryptInvitationCode, encryptInvitationCode } from "@/lib/invitation-secrets";
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
  accountTtlMinutes: number | null;
  revokedAt: Date | string | null;
};

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

function validateLinkConfiguration(): void {
  createInvitationUrl("configuration-check");
}

function inviteTtlDays(): number {
  const configured = Number(process.env.INVITATION_TTL_DAYS ?? 30);
  if (!Number.isInteger(configured) || configured < 1 || configured > 365) throw new Error("INVITATION_TTL_DAYS_INVALID");
  return configured;
}

const ACCOUNT_TTL_CHOICES = new Set([60, 240, 1440, 4320, 10080, 43200, 525600]);

function validateRequest(body: unknown): { orderRef: string; userId: string; sourceRef: string; accountTtlMinutes: number | null } | null {
  if (!isRecord(body) || typeof body.orderRef !== "string" || body.orderRef.trim().length < 1 || body.orderRef.length > 256) return null;
  if (/[\u0000-\u001f\u007f]/.test(body.orderRef)) return null;

  const orderRef = body.orderRef.trim();
  if (body.userId !== undefined && !validateUserId(body.userId)) return null;
  if (body.customerRef !== undefined && (typeof body.customerRef !== "string" || body.customerRef.trim().length < 1 || body.customerRef.length > 256)) return null;
  const accountTtlMinutes = body.accountTtlMinutes === undefined ? 1440 : body.accountTtlMinutes;
  if (accountTtlMinutes !== null && (!Number.isInteger(accountTtlMinutes) || !ACCOUNT_TTL_CHOICES.has(accountTtlMinutes as number))) return null;

  const customerRef = typeof body.customerRef === "string" ? body.customerRef.trim() : orderRef;
  const userId = typeof body.userId === "string"
    ? body.userId
    : `taobao_${createHash("sha256").update(customerRef).digest("hex").slice(0, 24)}`;
  const sourceRef = createHash("sha256").update(`${SOURCE}:${orderRef}`).digest("hex");
  return { orderRef, userId, sourceRef, accountTtlMinutes: accountTtlMinutes as number | null };
}

async function findIssuedInvitation(connection: PoolConnection, sourceRef: string): Promise<IssuedInvitation | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id, user_id AS userId, code_hash AS codeHash, code_ciphertext AS codeCiphertext,
            expires_at AS expiresAt, account_ttl_minutes AS accountTtlMinutes, revoked_at AS revokedAt
     FROM invitations WHERE issue_source = ? AND source_ref = ? FOR UPDATE`,
    [SOURCE, sourceRef],
  );
  return (rows[0] as IssuedInvitation | undefined) ?? null;
}

function issueResponse(invitation: IssuedInvitation, idempotent: boolean): Response {
  const code = invitation.codeCiphertext ? decryptInvitationCode(invitation.codeCiphertext) : "";
  const expiresAt = invitation.expiresAt ? new Date(invitation.expiresAt).toISOString() : null;
  return jsonResponse({
    userId: invitation.userId,
    invitationId: invitation.id,
    inviteUrl: createInvitationUrl(code),
    expiresAt,
    accountTtlMinutes: invitation.accountTtlMinutes,
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
    encryptInvitationCode("configuration-check");
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
    await connection.execute(
      "INSERT INTO users (id, created_at) VALUES (?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id = id",
      [requestData.userId],
    );
    const [userRows] = await connection.execute<RowDataPacket[]>("SELECT disabled_at AS disabledAt, account_expires_at AS accountExpiresAt FROM users WHERE id = ? FOR UPDATE", [requestData.userId]);
    if (!userRows[0] || userRows[0].disabledAt) {
      await connection.rollback();
      return jsonResponse({ error: "user_disabled" }, 409);
    }
    if (userRows[0].accountExpiresAt && new Date(userRows[0].accountExpiresAt) <= new Date()) {
      await connection.rollback();
      return jsonResponse({ error: "account_expired" }, 409);
    }
    const existing = await findIssuedInvitation(connection, requestData.sourceRef);
    if (existing) {
      if (existing.userId !== requestData.userId) {
        await connection.rollback();
        return jsonResponse({ error: "order_conflict" }, 409);
      }
      if (existing.accountTtlMinutes !== requestData.accountTtlMinutes) {
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

    const rawCode = makeCode(randomBytes(20));
    const normalizedCode = normalizeCode(rawCode);
    const invitation: IssuedInvitation = {
      id: randomUUID(),
      userId: requestData.userId,
      codeHash: createHash("sha256").update(normalizedCode).digest("hex"),
      codeCiphertext: encryptInvitationCode(rawCode),
      expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
      accountTtlMinutes: requestData.accountTtlMinutes,
      revokedAt: null,
    };
    const batchId = `${SOURCE}-${requestData.sourceRef.slice(0, 48)}`;
    await connection.execute(
      `INSERT INTO invitations
       (id, user_id, batch_id, ordinal, code_hash, created_at, expires_at, account_ttl_minutes, issue_source, source_ref, code_ciphertext)
       VALUES (?, ?, ?, 1, ?, UTC_TIMESTAMP(3), ?, ?, ?, ?, ?)`,
      [invitation.id, invitation.userId, batchId, invitation.codeHash, invitation.expiresAt, invitation.accountTtlMinutes, SOURCE, requestData.sourceRef, invitation.codeCiphertext],
    );
    await connection.execute(
      "INSERT INTO audit_events (id, actor_type, action, target_id, metadata, created_at) VALUES (?, 'admin', 'invitation.issued', ?, ?, UTC_TIMESTAMP(3))",
      [randomUUID(), invitation.id, JSON.stringify({ source: SOURCE, sourceRefHash: requestData.sourceRef, accountTtlMinutes: invitation.accountTtlMinutes })],
    );
    await connection.commit();
    return issueResponse(invitation, false);
  } catch (error) {
    await connection.rollback();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
      try {
        const existing = await findIssuedInvitation(connection, requestData.sourceRef);
        if (existing && existing.userId === requestData.userId && existing.accountTtlMinutes === requestData.accountTtlMinutes) {
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
