import type { RowDataPacket } from "mysql2/promise";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const limit = Math.floor(Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50)));
    const [rows] = await getPool().execute<RowDataPacket[]>(
      `SELECT id, user_id AS userId, batch_id AS batchId, ordinal, issue_source AS issueSource,
              source_ref AS sourceRefHash, created_at AS createdAt, expires_at AS expiresAt,
              redeemed_at AS redeemedAt, revoked_at AS revokedAt
       FROM invitations ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
      [],
    );
    return jsonResponse({ invitations: rows });
  } catch (error) {
    console.error("Admin invitation list failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
