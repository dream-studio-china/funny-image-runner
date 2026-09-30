import type { RowDataPacket } from "mysql2/promise";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { jsonResponse } from "@/lib/http";
import { createPrivateDownloadUrl } from "@/lib/qiniu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function parseImageId(value: string): { kind: "input" | "output" | "cover"; recordId: string; outputIndex?: number } | null {
  const input = value.match(/^input:([0-9a-f-]{36})$/i);
  if (input) return { kind: "input", recordId: input[1] };
  const output = value.match(/^output:([0-9a-f-]{36}):(\d+)$/i);
  if (output) {
    const outputIndex = Number(output[2]);
    if (Number.isSafeInteger(outputIndex) && outputIndex >= 0 && outputIndex < 4) return { kind: "output", recordId: output[1], outputIndex };
  }
  const cover = value.match(/^cover:([0-9a-f-]{36})$/i);
  if (cover) return { kind: "cover", recordId: cover[1] };
  return null;
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  const { id } = await params;
  const target = parseImageId(id);
  if (!target) return jsonResponse({ error: "image_not_found" }, 404);

  try {
    let rows: RowDataPacket[];
    if (target.kind === "input") {
      [rows] = await getPool().execute<RowDataPacket[]>("SELECT object_key AS objectKey FROM uploads WHERE id = ? AND deleted_at IS NULL LIMIT 1", [target.recordId]);
    } else if (target.kind === "output") {
      [rows] = await getPool().execute<RowDataPacket[]>("SELECT object_key AS objectKey FROM job_outputs WHERE job_id = ? AND output_index = ? AND deleted_at IS NULL LIMIT 1", [target.recordId, target.outputIndex!]);
    } else {
      [rows] = await getPool().execute<RowDataPacket[]>("SELECT object_key AS objectKey FROM preset_assets WHERE id = ? AND deleted_at IS NULL LIMIT 1", [target.recordId]);
    }
    const key = rows[0]?.objectKey;
    if (typeof key !== "string") return jsonResponse({ error: "image_not_found" }, 404);
    return jsonResponse({ url: createPrivateDownloadUrl(key, 300) });
  } catch (error) {
    console.error("Admin original image URL failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
