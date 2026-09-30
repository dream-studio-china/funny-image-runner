import type { RowDataPacket } from "mysql2/promise";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { jsonResponse, validateUserId } from "@/lib/http";
import { createPrivateDownloadUrl } from "@/lib/qiniu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  const { id: userId } = await params;
  if (!validateUserId(userId)) return jsonResponse({ error: "user_not_found" }, 404);
  const limit = Math.floor(Math.min(50, Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 30) || 30)));

  try {
    const [rows] = await getPool().execute<RowDataPacket[]>(
      `SELECT j.id, j.status, j.phase, j.attempts, j.preset_id AS presetId,
              j.preset_version AS presetVersion, j.parameters, j.error_code AS errorCode,
              j.created_at AS createdAt, j.updated_at AS updatedAt, j.finished_at AS finishedAt,
              u.object_key AS inputKey, u.content_type AS inputContentType,
              u.declared_size AS inputSize, u.created_at AS inputCreatedAt
       FROM jobs j JOIN uploads u ON u.id = j.upload_id AND u.user_id = j.user_id
       WHERE j.user_id = ? ORDER BY j.created_at DESC, j.id DESC LIMIT ${limit}`,
      [userId],
    );
    if (!rows.length) return jsonResponse({ jobs: [] });
    const ids = rows.map((row) => row.id as string);
    const placeholders = ids.map(() => "?").join(",");
    const [outputs] = await getPool().execute<RowDataPacket[]>(
      `SELECT job_id AS jobId, output_index AS outputIndex, object_key AS objectKey,
              content_type AS contentType, size FROM job_outputs
       WHERE job_id IN (${placeholders}) ORDER BY job_id, output_index`,
      ids,
    );
    const outputsByJob = new Map<string, RowDataPacket[]>();
    for (const output of outputs) {
      const jobId = output.jobId as string;
      outputsByJob.set(jobId, [...(outputsByJob.get(jobId) ?? []), output]);
    }
    return jsonResponse({ jobs: rows.map((row) => ({
      id: row.id,
      status: row.status,
      phase: row.phase,
      attempts: row.attempts,
      presetId: row.presetId,
      presetVersion: row.presetVersion,
      parameters: row.parameters,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finishedAt: row.finishedAt,
      input: { url: createPrivateDownloadUrl(row.inputKey as string), contentType: row.inputContentType, size: row.inputSize, createdAt: row.inputCreatedAt },
      outputs: (outputsByJob.get(row.id as string) ?? []).map((output) => ({
        index: output.outputIndex,
        url: createPrivateDownloadUrl(output.objectKey as string),
        contentType: output.contentType,
        size: output.size,
      })),
    })) });
  } catch (error) {
    console.error("Admin user job lookup failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
