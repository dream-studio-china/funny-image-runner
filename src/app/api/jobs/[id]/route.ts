import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";

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
    const [rows] = await getPool().execute<RowDataPacket[]>(
      `SELECT id, preset_id AS presetId, preset_version AS presetVersion, status, error_code AS errorCode,
              created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt
       FROM jobs WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, user.id],
    );
    return rows[0] ? jsonResponse({ job: rows[0] }) : jsonResponse({ error: "not_found" }, 404);
  } catch (error) {
    console.error("Job query failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
