import { getPool } from "@/lib/db";
import { createUploadCredential, isAllowedImageType, MAX_UPLOAD_BYTES } from "@/lib/qiniu";
import { authorized, lockLease, MAX_OUTPUTS, parseWorkerBody, rejectUnauthorized, unavailable, withinRateLimit } from "@/lib/worker-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!authorized(request)) return rejectUnauthorized();
  try { if (!await withinRateLimit(request, "output-upload")) return jsonResponse({ error: "rate_limited" }, 429); } catch { return unavailable(); }
  const body = await parseWorkerBody(request);
  if (body instanceof Response) return body;
  const { id } = await context.params;
  const index = body.index;
  const size = body.size;
  if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= MAX_OUTPUTS || !Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > MAX_UPLOAD_BYTES || typeof body.contentType !== "string" || !isAllowedImageType(body.contentType)) return jsonResponse({ error: "invalid_output" }, 400);
  try {
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      const job = await lockLease(connection, id, body.leaseToken);
      if (!job) { await connection.rollback(); return jsonResponse({ error: "lease_invalid" }, 409); }
      await connection.commit();
    } finally { connection.release(); }
    const key = `outputs/${id}/${index}`;
    // This deterministic per-job key must be safely retryable if upload succeeded
    // but the worker lost the response before reporting completion.
    const credential = createUploadCredential(key, Number(size), false);
    return jsonResponse({ key, uploadUrl: credential.uploadUrl, uploadToken: credential.uploadToken });
  } catch (error) { console.error("Worker output credential failed", error instanceof Error ? error.message : "unknown error"); return unavailable(); }
}
