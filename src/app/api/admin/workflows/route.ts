import { randomUUID } from "node:crypto";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
import { listWorkflowConfigs } from "@/lib/workflow-store";
import { hasValidPresetNodeMapping } from "@/lib/preset-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
    return jsonResponse({ workflows: await listWorkflowConfigs() });
  } catch (error) {
    console.error("Admin workflow list failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try { if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401); } catch { return jsonResponse({ error: "service_unavailable" }, 503); }
  let body: unknown;
  try { body = await readJson(request, 2_000_000); } catch { return jsonResponse({ error: "invalid_json" }, 400); }
  if (!isRecord(body) || typeof body.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(body.id) || typeof body.name !== "string" || !body.name.trim() || body.name.length > 100 || !isRecord(body.workflow) || JSON.stringify(body.workflow).length > 1_500_000 || !isRecord(body.nodeMapping) || !hasValidPresetNodeMapping(body.workflow, body.nodeMapping, null, null) || (body.enabled !== undefined && typeof body.enabled !== "boolean")) return jsonResponse({ error: "invalid_workflow_config" }, 400);
  try {
    await getPool().execute("INSERT INTO workflow_configs (id,name,version,workflow,node_mapping,enabled) VALUES (?,?,1,?,?,?)", [body.id, body.name.trim(), JSON.stringify(body.workflow), JSON.stringify(body.nodeMapping), body.enabled === false ? 0 : 1]);
    const workflow = (await listWorkflowConfigs()).find((item) => item.id === body.id);
    await getPool().execute("INSERT INTO audit_events (id,actor_type,action,target_id,created_at) VALUES (?,'admin','workflow.created',?,UTC_TIMESTAMP(3))", [randomUUID(), body.id]);
    return jsonResponse({ workflow }, 201);
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") return jsonResponse({ error: "workflow_exists" }, 409);
    console.error("Admin workflow create failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
