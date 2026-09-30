import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { authorized, rejectUnauthorized, unavailable, withinRateLimit } from "@/lib/worker-auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string; version: string }> }): Promise<Response> {
  if (!authorized(request)) return rejectUnauthorized();
  try { if (!await withinRateLimit(request, "preset", 120)) return jsonResponse({ error: "rate_limited" }, 429); } catch { return unavailable(); }
  const { id, version: rawVersion } = await context.params;
  const version = Number(rawVersion);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !Number.isSafeInteger(version) || version < 1) return jsonResponse({ error: "not_found" }, 404);
  try {
    const [rows] = await getPool().execute<RowDataPacket[]>(
      "SELECT workflow,prompt,negative_prompt AS negativePrompt,additional,node_mapping AS nodeMapping FROM preset_versions WHERE preset_id=? AND version=? LIMIT 1", [id, version],
    );
    const row = rows[0];
    let workflow = row?.workflow;
    if (typeof workflow === "string") workflow = JSON.parse(workflow) as unknown;
    if (!row || !workflow || typeof workflow !== "object" || Array.isArray(workflow) || Object.keys(workflow).length === 0) return jsonResponse({ error: "preset_not_found_or_unavailable" }, 404);
    const jsonField = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) as unknown : value;
    return jsonResponse({ preset: { workflow, prompt: row.prompt, negativePrompt: row.negativePrompt, additional: jsonField(row.additional), nodeMapping: jsonField(row.nodeMapping) } });
  } catch (error) {
    console.error("Worker preset lookup failed", error instanceof Error ? error.message : "unknown error");
    return unavailable();
  }
}
