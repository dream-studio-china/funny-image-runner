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
  if (!isRecord(body)) return jsonResponse({ error: "invalid_request" }, 400);
  const hasDisabled = Object.hasOwn(body, "disabled");
  const hasTotalLimit = Object.hasOwn(body, "totalJobLimit");
  const hasDailyLimit = Object.hasOwn(body, "dailyJobLimit");
  const hasAccountExpiry = Object.hasOwn(body, "accountExpiresAt");
  if ((!hasDisabled && !hasTotalLimit && !hasDailyLimit && !hasAccountExpiry) ||
      (hasDisabled && typeof body.disabled !== "boolean") ||
      (hasTotalLimit && !(body.totalJobLimit === null || (Number.isSafeInteger(body.totalJobLimit) && Number(body.totalJobLimit) >= 0 && Number(body.totalJobLimit) <= 1_000_000))) ||
      (hasDailyLimit && !(body.dailyJobLimit === null || (Number.isSafeInteger(body.dailyJobLimit) && Number(body.dailyJobLimit) >= 0 && Number(body.dailyJobLimit) <= 1_000_000)))) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  let accountExpiresAt: Date | null | undefined;
  if (hasAccountExpiry) {
    if (body.accountExpiresAt === null) accountExpiresAt = null;
    else if (typeof body.accountExpiresAt === "string") {
      accountExpiresAt = new Date(body.accountExpiresAt);
      if (!Number.isFinite(accountExpiresAt.getTime())) return jsonResponse({ error: "invalid_request" }, 400);
    } else return jsonResponse({ error: "invalid_request" }, 400);
  }
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
    const assignments: string[] = [];
    const values: (string | number | Date | null | boolean)[] = [];
    if (hasDisabled) { assignments.push("disabled_at = IF(?, NULL, UTC_TIMESTAMP(3))"); values.push(body.disabled as boolean); }
    if (hasTotalLimit) { assignments.push("total_job_limit = ?"); values.push(body.totalJobLimit as number | null); }
    if (hasDailyLimit) { assignments.push("daily_job_limit = ?"); values.push(body.dailyJobLimit as number | null); }
    if (hasAccountExpiry) { assignments.push("account_expires_at = ?, account_expiry_initialized = 1"); values.push(accountExpiresAt as Date | null); }
    values.push(id);
    await connection.execute(`UPDATE users SET ${assignments.join(", ")} WHERE id = ?`, values);
    if (body.disabled === true) {
      await connection.execute("UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL", [id]);
    }
    await connection.execute(
      "INSERT INTO audit_events (id, actor_type, action, target_id, metadata, created_at) VALUES (?, 'admin', ?, ?, ?, UTC_TIMESTAMP(3))",
      [randomUUID(), hasDisabled && !hasTotalLimit && !hasDailyLimit && !hasAccountExpiry ? "user.status_changed" : "user.limits_updated", id, JSON.stringify({ ...(hasDisabled ? { disabled: body.disabled } : {}), ...(hasTotalLimit ? { totalJobLimit: body.totalJobLimit } : {}), ...(hasDailyLimit ? { dailyJobLimit: body.dailyJobLimit } : {}), ...(hasAccountExpiry ? { accountExpiresAt } : {}) })],
    );
    await connection.commit();
    return jsonResponse({ userId: id, ...(hasDisabled ? { disabled: body.disabled } : {}), ...(hasTotalLimit ? { totalJobLimit: body.totalJobLimit } : {}), ...(hasDailyLimit ? { dailyJobLimit: body.dailyJobLimit } : {}), ...(hasAccountExpiry ? { accountExpiresAt } : {}) });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Admin user update failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  } finally {
    connection?.release();
  }
}
