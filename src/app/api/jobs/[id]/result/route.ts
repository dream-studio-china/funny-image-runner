import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { createPrivateDownloadUrl, createPrivateImageViewUrl } from "@/lib/qiniu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  let user;
  try {
    user = await getSessionUser(request.headers.get("cookie"));
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonResponse({ error: "not_found" }, 404);
  try {
    const [jobs] = await getPool().execute<RowDataPacket[]>(
      `SELECT j.id, u.object_key AS inputKey, u.content_type AS inputContentType,
              u.declared_size AS inputSize, u.deleted_at AS inputDeletedAt
       FROM jobs j JOIN uploads u ON u.id = j.upload_id AND u.user_id = j.user_id
       WHERE j.id = ? AND j.user_id = ? AND j.status = 'succeeded' LIMIT 1`,
      [id, user.id],
    );
    if (!jobs[0]) return jsonResponse({ error: "result_not_ready" }, 409);
    const [outputs] = await getPool().execute<RowDataPacket[]>(
      "SELECT output_index AS `index`, object_key AS objectKey, content_type AS contentType, size FROM job_outputs WHERE job_id = ? AND deleted_at IS NULL ORDER BY output_index",
      [id],
    );
    const job = jobs[0];
    return jsonResponse({
      input: {
        url: job.inputDeletedAt ? null : createPrivateDownloadUrl(job.inputKey as string),
        previewUrl: job.inputDeletedAt ? null : createPrivateImageViewUrl(job.inputKey as string, { mode: 2, width: 1100, height: 900, quality: 84, format: "webp" }),
        contentType: job.inputContentType,
        size: Number(job.inputSize),
        deleted: Boolean(job.inputDeletedAt),
      },
      results: outputs.map((output) => ({
        index: output.index,
        contentType: output.contentType,
        size: Number(output.size),
        url: createPrivateDownloadUrl(output.objectKey as string),
        previewUrl: createPrivateImageViewUrl(output.objectKey as string, { mode: 2, width: 1100, height: 900, quality: 84, format: "webp" }),
      })),
    });
  } catch (error) {
    console.error("Job result lookup failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "storage_unavailable" }, 503);
  }
}
