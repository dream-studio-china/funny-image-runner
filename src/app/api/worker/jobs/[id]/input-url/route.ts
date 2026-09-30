import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { createPrivateDownloadUrl } from "@/lib/qiniu";
import { authorized, lockLease, parseWorkerBody, rejectUnauthorized, unavailable, withinRateLimit } from "@/lib/worker-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!authorized(request)) return rejectUnauthorized();
  try { if (!await withinRateLimit(request, "input-url")) return jsonResponse({ error: "rate_limited" }, 429); } catch { return unavailable(); }
  const body = await parseWorkerBody(request);
  if (body instanceof Response) return body;
  const { id } = await context.params;
  try {
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      const job = await lockLease(connection, id, body.leaseToken);
      if (!job) { await connection.rollback(); return jsonResponse({ error: "lease_invalid" }, 409); }
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT u.object_key AS objectKey,u.content_type AS contentType,u.declared_size AS size
         FROM uploads u JOIN jobs j ON j.upload_id=u.id WHERE j.id=? AND u.consumed_job_id=j.id LIMIT 1`, [id],
      );
      await connection.commit();
      if (!rows[0]) return jsonResponse({ error: "input_not_found" }, 404);
      return jsonResponse({ url: createPrivateDownloadUrl(String(rows[0].objectKey), 120), contentType: rows[0].contentType, size: Number(rows[0].size) });
    } finally { connection.release(); }
  } catch (error) { console.error("Worker input URL failed", error instanceof Error ? error.message : "unknown error"); return unavailable(); }
}
