import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { authorized, hashLease, LEASE_SECONDS, newLeaseToken, rejectUnauthorized, unavailable, withinRateLimit } from "@/lib/worker-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return rejectUnauthorized();
  try { if (!await withinRateLimit(request, "claim", 120)) return jsonResponse({ error: "rate_limited" }, 429); } catch { return unavailable(); }
  let connection;
  try { connection = await getPool().getConnection(); } catch { return unavailable(); }
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE jobs SET status='failed',phase='failed',error_code='attempt_timeout',finished_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3),lease_token_hash=NULL,lease_until=NULL
       WHERE status='running' AND updated_at <= UTC_TIMESTAMP(3) - INTERVAL 20 MINUTE`,
    );
    await connection.execute(
      `UPDATE jobs SET status='failed',phase='failed',error_code='execution_uncertain',finished_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3),lease_token_hash=NULL,lease_until=NULL
       WHERE status='running' AND lease_until <= UTC_TIMESTAMP(3) AND phase='prompt_submitting' AND prompt_id IS NULL`,
    );
    await connection.execute(
      `UPDATE jobs SET status='failed',phase='failed',error_code='worker_attempt_limit',finished_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3),lease_token_hash=NULL,lease_until=NULL
       WHERE status='running' AND lease_until <= UTC_TIMESTAMP(3) AND attempts >= 3`,
    );
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id,preset_id AS presetId,preset_version AS presetVersion,parameters,attempts,phase,prompt_id AS promptId
       FROM jobs WHERE status='queued' OR (status='running' AND lease_until <= UTC_TIMESTAMP(3) AND prompt_id IS NOT NULL)
       ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const job = rows[0];
    if (!job) { await connection.commit(); return new Response(null, { status: 204, headers: { "cache-control": "no-store" } }); }
    const token = newLeaseToken();
    await connection.execute(
      `UPDATE jobs SET status='running',attempts=attempts+1,phase='claimed',lease_token_hash=?,
       lease_until=UTC_TIMESTAMP(3) + INTERVAL ${LEASE_SECONDS} SECOND,updated_at=UTC_TIMESTAMP(3) WHERE id=?`,
      [hashLease(token), job.id],
    );
    await connection.commit();
    let parameters = job.parameters;
    if (typeof parameters === "string") parameters = JSON.parse(parameters) as unknown;
     return jsonResponse({ job: { id: job.id, presetId: job.presetId, presetVersion: Number(job.presetVersion), parameters, phase: "claimed", promptId: job.promptId, leaseToken: token } });
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    console.error("Worker claim failed", error instanceof Error ? error.message : "unknown error");
    return unavailable();
  } finally { connection.release(); }
}
