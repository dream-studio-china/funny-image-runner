import { getPool } from "@/lib/db";
import { authorized, lockLease, parseWorkerBody, rejectUnauthorized, unavailable, withinRateLimit } from "@/lib/worker-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!authorized(request)) return rejectUnauthorized();
  try { if (!await withinRateLimit(request, "fail", 10)) return jsonResponse({ error: "rate_limited" }, 429); } catch { return unavailable(); }
  const body = await parseWorkerBody(request);
  if (body instanceof Response) return body;
  const { id } = await context.params;
  if (typeof body.errorCode !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.errorCode)) return jsonResponse({ error: "invalid_error_code" }, 400);
  try {
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      const job = await lockLease(connection, id, body.leaseToken);
      if (!job) { await connection.rollback(); return jsonResponse({ error: "lease_invalid" }, 409); }
      await connection.execute("UPDATE jobs SET status='failed',phase='failed',error_code=?,finished_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3),lease_token_hash=NULL,lease_until=NULL WHERE id=?", [body.errorCode, id]);
      await connection.commit();
      return jsonResponse({ ok: true });
    } finally { connection.release(); }
  } catch (error) { console.error("Worker failure update failed", error instanceof Error ? error.message : "unknown error"); return unavailable(); }
}
