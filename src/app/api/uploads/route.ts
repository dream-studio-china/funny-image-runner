import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
import { createUploadCredential, isAllowedImageType, MAX_UPLOAD_BYTES } from "@/lib/qiniu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  let user;
  try {
    user = await getSessionUser(request.headers.get("cookie"));
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  let body: unknown;
  try {
    body = await readJson(request, 4096);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "BODY_TOO_LARGE";
    return jsonResponse({ error: tooLarge ? "body_too_large" : "invalid_json" }, tooLarge ? 413 : 400);
  }
  if (!isRecord(body)) return jsonResponse({ error: "invalid_upload" }, 400);
  const contentType = body.contentType;
  const size = body.size;
  if (typeof contentType !== "string" || !isAllowedImageType(contentType) ||
      typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
    return jsonResponse({ error: "invalid_upload" }, 400);
  }

  const uploadId = randomUUID();
  const objectKey = `inputs/${user.id}/${uploadId}`;
  try {
    const [rows] = await getPool().execute(
      `SELECT COUNT(*) AS total FROM uploads
       WHERE user_id = ? AND consumed_job_id IS NULL AND expires_at > UTC_TIMESTAMP(3)`,
      [user.id],
    );
    const count = Number((rows as Array<{ total: number }>)[0]?.total ?? 0);
    if (count >= 5) return jsonResponse({ error: "too_many_pending_uploads" }, 429);

    const credentials = createUploadCredential(objectKey);
    await getPool().execute(
      `INSERT INTO uploads (id, user_id, object_key, content_type, declared_size, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [uploadId, user.id, objectKey, contentType, size, credentials.expiresAt],
    );
    return jsonResponse({ uploadId, key: objectKey, ...credentials });
  } catch (error) {
    console.error("Upload credential creation failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "storage_unavailable" }, 503);
  }
}
