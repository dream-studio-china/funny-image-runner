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
    const search = (url.searchParams.get("search") ?? "").trim().slice(0, 64);
    const limit = Math.floor(Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50)));
    const offset = Math.floor(Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0));
    const [countRows] = await getPool().execute<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM users WHERE (? = '' OR id LIKE ?)",
      [search, `%${search}%`],
    );
    const [rows] = await getPool().execute<RowDataPacket[]>(
      `SELECT u.id, u.created_at AS createdAt, u.disabled_at AS disabledAt,
              (SELECT COUNT(*) FROM invitations i WHERE i.user_id = u.id) AS invitationCount,
              (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id) AS jobCount
       FROM users u WHERE (? = '' OR u.id LIKE ?)
       ORDER BY u.created_at DESC, u.id LIMIT ${limit} OFFSET ${offset}`,
      [search, `%${search}%`],
    );
    return jsonResponse({ users: rows, total: Number(countRows[0]?.total ?? 0) });
  } catch (error) {
    console.error("Admin user list failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
