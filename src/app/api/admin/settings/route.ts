import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULTS = { totalJobLimit: null, dailyJobLimit: 10 };

async function ensureSettings(): Promise<RowDataPacket> {
  await getPool().execute("INSERT INTO system_settings (id, total_job_limit, daily_job_limit) VALUES (1, NULL, 10) ON DUPLICATE KEY UPDATE id = id");
  const [rows] = await getPool().execute<RowDataPacket[]>("SELECT total_job_limit AS totalJobLimit, daily_job_limit AS dailyJobLimit FROM system_settings WHERE id = 1");
  return (rows[0] ?? DEFAULTS) as RowDataPacket;
}

export async function GET(request: Request): Promise<Response> {
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
    const row = await ensureSettings();
    return jsonResponse({ settings: { totalJobLimit: row.totalJobLimit === null ? null : Number(row.totalJobLimit), dailyJobLimit: Number(row.dailyJobLimit) } });
  } catch (error) {
    console.error("Admin settings read failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  if (request.headers.has("cookie") && !isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
    const body: unknown = await readJson(request, 2048);
    if (!isRecord(body)) return jsonResponse({ error: "invalid_request" }, 400);
    const total = body.totalJobLimit;
    const daily = body.dailyJobLimit;
    if (!(total === null || (Number.isSafeInteger(total) && Number(total) >= 0 && Number(total) <= 1_000_000)) ||
        !Number.isSafeInteger(daily) || Number(daily) < 0 || Number(daily) > 1_000_000) {
      return jsonResponse({ error: "invalid_limits" }, 400);
    }
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("INSERT INTO system_settings (id, total_job_limit, daily_job_limit) VALUES (1, NULL, 10) ON DUPLICATE KEY UPDATE id = id");
      await connection.execute("UPDATE system_settings SET total_job_limit = ?, daily_job_limit = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = 1", [total as number | null, daily as number]);
      await connection.execute(
        "INSERT INTO audit_events (id, actor_type, action, target_id, metadata, created_at) VALUES (?, 'admin', 'settings.job_limits_updated', 'global', ?, UTC_TIMESTAMP(3))",
        [randomUUID(), JSON.stringify({ totalJobLimit: total as number | null, dailyJobLimit: daily as number })],
      );
      await connection.commit();
      return jsonResponse({ settings: { totalJobLimit: total as number | null, dailyJobLimit: daily as number } });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    if (error instanceof Error && error.message === "BODY_TOO_LARGE") return jsonResponse({ error: "body_too_large" }, 413);
    console.error("Admin settings update failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
