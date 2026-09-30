import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { createPrivateDownloadUrl } from "@/lib/qiniu";

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
      "SELECT id FROM jobs WHERE id = ? AND user_id = ? AND status = 'succeeded' LIMIT 1",
      [id, user.id],
    );
    if (!jobs[0]) return jsonResponse({ error: "result_not_ready" }, 409);
    const [outputs] = await getPool().execute<RowDataPacket[]>(
      "SELECT output_index AS `index`, object_key AS objectKey, content_type AS contentType FROM job_outputs WHERE job_id = ? ORDER BY output_index",
      [id],
    );
    return jsonResponse({ results: outputs.map((output) => ({
      index: output.index,
      contentType: output.contentType,
      url: createPrivateDownloadUrl(output.objectKey as string),
    })) });
  } catch (error) {
    console.error("Job result lookup failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "storage_unavailable" }, 503);
  }
}
