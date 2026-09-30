import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { authorized, rejectUnauthorized, unavailable, withinRateLimit, parseWorkerBody } from "@/lib/worker-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const states = new Set(["starting", "idle", "processing", "stopping"]);

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return rejectUnauthorized();
  try { if (!await withinRateLimit(request, "worker-heartbeat", 120)) return jsonResponse({ error: "rate_limited" }, 429); } catch { return unavailable(); }
  const body = await parseWorkerBody(request);
  if (body instanceof Response) return body;
  const { id, name, state, currentJobId, lastError } = body;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)
    || typeof name !== "string" || !name.trim() || name.trim().length > 128
    || typeof state !== "string" || !states.has(state)
    || (currentJobId !== undefined && currentJobId !== null && (typeof currentJobId !== "string" || !/^[0-9a-f-]{36}$/i.test(currentJobId)))
    || (lastError !== undefined && lastError !== null && (typeof lastError !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(lastError)))) return jsonResponse({ error: "invalid_worker_status" }, 400);
  try {
    await getPool().execute(
      `INSERT INTO workers (id,name,state,current_job_id,last_error,started_at,last_seen_at)
       VALUES (?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE started_at=IF(state<>'starting' AND VALUES(state)='starting',UTC_TIMESTAMP(3),started_at),
         name=VALUES(name),state=VALUES(state),current_job_id=VALUES(current_job_id),last_error=VALUES(last_error),last_seen_at=UTC_TIMESTAMP(3)`,
      [id, name.trim(), state, currentJobId ?? null, lastError ?? null],
    );
    const [rows] = await getPool().execute<RowDataPacket[]>("SELECT started_at AS startedAt,last_seen_at AS lastSeenAt FROM workers WHERE id=?", [id]);
    return jsonResponse({ worker: { id, name: name.trim(), state, currentJobId: currentJobId ?? null, lastError: lastError ?? null, startedAt: rows[0].startedAt, lastSeenAt: rows[0].lastSeenAt } });
  } catch (error) {
    console.error("Worker status heartbeat failed", error instanceof Error ? error.message : "unknown error");
    return unavailable();
  }
}
