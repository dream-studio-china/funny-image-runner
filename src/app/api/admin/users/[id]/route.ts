import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  if (request.headers.has("cookie") && !isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  let body: unknown;
  try { body = await readJson(request, 2048); } catch { return jsonResponse({ error: "invalid_json" }, 400); }
  if (!isRecord(body) || typeof body.disabled !== "boolean") return jsonResponse({ error: "invalid_request" }, 400);
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(id)) return jsonResponse({ error: "user_not_found" }, 404);

  let connection: PoolConnection | undefined;
  try {
    connection = await getPool().getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT id FROM users WHERE id = ? FOR UPDATE", [id]);
    if (!rows[0]) {
      await connection.rollback();
      return jsonResponse({ error: "user_not_found" }, 404);
    }
    await connection.execute(
      "UPDATE users SET disabled_at = IF(?, NULL, UTC_TIMESTAMP(3)) WHERE id = ?",
      [body.disabled, id],
    );
    if (body.disabled) {
      await connection.execute("UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL", [id]);
    }
    await connection.execute(
      "INSERT INTO audit_events (id, actor_type, action, target_id, metadata, created_at) VALUES (?, 'admin', 'user.status_changed', ?, ?, UTC_TIMESTAMP(3))",
      [randomUUID(), id, JSON.stringify({ disabled: body.disabled })],
    );
    await connection.commit();
    return jsonResponse({ userId: id, disabled: body.disabled });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Admin user update failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  } finally {
    connection?.release();
  }
}
