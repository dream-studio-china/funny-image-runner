import type { RowDataPacket } from "mysql2/promise";
import { isAdminRequest } from "@/lib/admin-auth";
import { createInvitationUrl, decryptInvitationCode } from "@/lib/invitation-secrets";
import { getPool } from "@/lib/db";
import { jsonResponse, validateUserId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  const { id: userId } = await params;
  if (!validateUserId(userId)) return jsonResponse({ error: "user_not_found" }, 404);

  try {
    const [rows] = await getPool().execute<RowDataPacket[]>(
      `SELECT id, batch_id AS batchId, ordinal, issue_source AS issueSource,
              created_at AS createdAt, expires_at AS expiresAt,
              redeemed_at AS redeemedAt, revoked_at AS revokedAt, code_ciphertext AS codeCiphertext
       FROM invitations WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
      [userId],
    );
    const invitations = rows.map((row) => {
      const revokedAt = row.revokedAt ? new Date(row.revokedAt) : null;
      const expiresAt = row.expiresAt ? new Date(row.expiresAt) : null;
      const unavailableReason = revokedAt ? "revoked" : expiresAt && expiresAt <= new Date() ? "expired" : row.codeCiphertext ? null : "hash_only";
      const code = !unavailableReason && typeof row.codeCiphertext === "string" ? decryptInvitationCode(row.codeCiphertext) : null;
      return {
        id: row.id,
        userId,
        batchId: row.batchId,
        ordinal: row.ordinal,
        issueSource: row.issueSource,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        redeemedAt: row.redeemedAt,
        revokedAt: row.revokedAt,
        inviteCode: code,
        inviteUrl: code ? createInvitationUrl(code) : null,
        unavailableReason,
      };
    });
    return jsonResponse({ invitations });
  } catch (error) {
    console.error("Admin user invitation lookup failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
