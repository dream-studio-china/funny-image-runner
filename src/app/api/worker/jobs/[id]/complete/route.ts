import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { isAllowedImageType, MAX_UPLOAD_BYTES, verifyUploadedObject } from "@/lib/qiniu";
import { authorized, lockLease, MAX_OUTPUTS, parseWorkerBody, rejectUnauthorized, unavailable, withinRateLimit } from "@/lib/worker-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Output = { index: number; key: string; contentType: string; size: number };
function parseOutputs(value: unknown, id: string): Output[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OUTPUTS) return null;
  const seen = new Set<number>();
  const outputs: Output[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (!Number.isSafeInteger(row.index) || Number(row.index) < 0 || Number(row.index) >= MAX_OUTPUTS || seen.has(Number(row.index))) return null;
    if (row.key !== `outputs/${id}/${row.index}` || typeof row.contentType !== "string" || !isAllowedImageType(row.contentType) || !Number.isSafeInteger(row.size) || Number(row.size) < 1 || Number(row.size) > MAX_UPLOAD_BYTES) return null;
    seen.add(Number(row.index));
    outputs.push({ index: Number(row.index), key: row.key, contentType: row.contentType, size: Number(row.size) });
  }
  return outputs;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!authorized(request)) return rejectUnauthorized();
  try { if (!await withinRateLimit(request, "complete", 10)) return jsonResponse({ error: "rate_limited" }, 429); } catch { return unavailable(); }
  const body = await parseWorkerBody(request);
  if (body instanceof Response) return body;
  const { id } = await context.params;
  const outputs = parseOutputs(body.outputs, id);
  if (!outputs) return jsonResponse({ error: "invalid_outputs" }, 400);
  try {
    await Promise.all(outputs.map((output) => verifyUploadedObject(output.key, output.size, output.contentType)));
  } catch (error) {
    if (error instanceof Error && error.message === "QINIU_OBJECT_NOT_FOUND") return jsonResponse({ error: "output_not_found" }, 422);
    if (error instanceof Error && error.message === "QINIU_OBJECT_MISMATCH") return jsonResponse({ error: "output_mismatch" }, 422);
    console.error("Worker output verification failed", error instanceof Error ? error.message : "unknown error");
    return unavailable();
  }
  let connection;
  try { connection = await getPool().getConnection(); } catch { return unavailable(); }
  try {
    await connection.beginTransaction();
    const job = await lockLease(connection, id, body.leaseToken);
    if (!job) { await connection.rollback(); return jsonResponse({ error: "lease_invalid" }, 409); }
    const [existing] = await connection.execute<RowDataPacket[]>("SELECT output_index FROM job_outputs WHERE job_id=?", [id]);
    if (existing.length) { await connection.rollback(); return jsonResponse({ error: "outputs_already_recorded" }, 409); }
    for (const output of outputs) {
      await connection.execute("INSERT INTO job_outputs (job_id,output_index,object_key,content_type,size) VALUES (?,?,?,?,?)", [id, output.index, output.key, output.contentType, output.size]);
    }
    await connection.execute("UPDATE jobs SET status='succeeded',phase='complete',error_code=NULL,finished_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3),lease_token_hash=NULL,lease_until=NULL WHERE id=?", [id]);
    await connection.commit();
    return jsonResponse({ ok: true });
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    console.error("Worker job completion failed", error instanceof Error ? error.message : "unknown error");
    return unavailable();
  } finally { connection.release(); }
}
