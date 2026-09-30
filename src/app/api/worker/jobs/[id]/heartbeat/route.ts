import { getPool } from "@/lib/db";
import { authorized, LEASE_SECONDS, lockLease, parseWorkerBody, rejectUnauthorized, unavailable, withinRateLimit } from "@/lib/worker-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const phases = new Set(["claimed", "downloading_input", "uploading_input", "prompt_submitting", "generating", "downloading_output", "uploading_output"]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!authorized(request)) return rejectUnauthorized();
  try { if (!await withinRateLimit(request, "heartbeat", 120)) return jsonResponse({ error: "rate_limited" }, 429); } catch { return unavailable(); }
  const body = await parseWorkerBody(request);
  if (body instanceof Response) return body;
  const { id } = await context.params;
  if (typeof body.phase !== "string" || !phases.has(body.phase)) return jsonResponse({ error: "invalid_phase" }, 400);
  if (body.promptId !== undefined && (typeof body.promptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.promptId))) return jsonResponse({ error: "invalid_prompt_id" }, 400);
  try {
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      const job = await lockLease(connection, id, body.leaseToken);
      if (!job) { await connection.rollback(); return jsonResponse({ error: "lease_invalid" }, 409); }
      let promptId = job.promptId;
      if (body.promptId !== undefined) {
        if (promptId === null) {
          if (job.phase !== "prompt_submitting" || body.phase !== "generating") { await connection.rollback(); return jsonResponse({ error: "prompt_id_phase_invalid" }, 409); }
          promptId = body.promptId;
        } else if (promptId !== body.promptId) { await connection.rollback(); return jsonResponse({ error: "prompt_id_conflict" }, 409); }
      }
      await connection.execute(
        `UPDATE jobs SET phase=?,prompt_id=?,lease_until=LEAST(UTC_TIMESTAMP(3) + INTERVAL ${LEASE_SECONDS} SECOND,updated_at + INTERVAL 20 MINUTE) WHERE id=?`,
        [body.phase, promptId, id],
      );
      await connection.commit();
      return jsonResponse({ ok: true, leaseUntilSeconds: LEASE_SECONDS });
    } finally { connection.release(); }
  } catch (error) { console.error("Worker heartbeat failed", error instanceof Error ? error.message : "unknown error"); return unavailable(); }
}
