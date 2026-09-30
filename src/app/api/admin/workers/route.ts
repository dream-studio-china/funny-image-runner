import type { RowDataPacket } from "mysql2/promise";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
    const [rows] = await getPool().execute<RowDataPacket[]>(
      `SELECT id,name,state,current_job_id AS currentJobId,last_error AS lastError,
              started_at AS startedAt,last_seen_at AS lastSeenAt,
              (last_seen_at <= UTC_TIMESTAMP(3) - INTERVAL 45 SECOND) AS stale
       FROM workers ORDER BY name,id`,
    );
    return jsonResponse({ workers: rows.map(({ stale, ...worker }) => ({ ...worker, status: Number(stale) === 1 ? "offline" : worker.state })) });
  } catch (error) {
    console.error("Admin worker list failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
