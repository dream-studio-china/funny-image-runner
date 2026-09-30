import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
import { mapWorkflowConfig } from "@/lib/workflow-store";
import { hasValidPresetNodeMapping } from "@/lib/preset-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try { if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401); } catch { return jsonResponse({ error: "service_unavailable" }, 503); }
  let body: unknown;
  try { body = await readJson(request, 2_000_000); } catch { return jsonResponse({ error: "invalid_json" }, 400); }
  if (!isRecord(body) || (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100)) || (body.enabled !== undefined && typeof body.enabled !== "boolean") || (body.workflow !== undefined && !isRecord(body.workflow)) || (body.nodeMapping !== undefined && !isRecord(body.nodeMapping)) || (body.workflow !== undefined && JSON.stringify(body.workflow).length > 1_500_000)) return jsonResponse({ error: "invalid_workflow_config" }, 400);
  const { id } = await params;
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT id,name,version,workflow,node_mapping AS nodeMapping,enabled,created_at AS createdAt,updated_at AS updatedAt FROM workflow_configs WHERE id=? FOR UPDATE", [id]);
    if (!rows[0]) { await connection.rollback(); return jsonResponse({ error: "workflow_not_found" }, 404); }
    const prior = mapWorkflowConfig(rows[0]);
    const workflow = body.workflow === undefined ? prior.workflow : body.workflow;
    const nodeMapping = body.nodeMapping === undefined ? prior.nodeMapping : body.nodeMapping;
    if (!hasValidPresetNodeMapping(workflow, nodeMapping, null, null)) { await connection.rollback(); return jsonResponse({ error: "invalid_node_mapping" }, 400); }
    const changed = JSON.stringify(workflow) !== JSON.stringify(prior.workflow) || JSON.stringify(nodeMapping) !== JSON.stringify(prior.nodeMapping);
    const version = prior.version + (changed ? 1 : 0);
    const [result] = await connection.execute<ResultSetHeader>("UPDATE workflow_configs SET name=?,version=?,workflow=?,node_mapping=?,enabled=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [body.name === undefined ? prior.name : body.name.trim(), version, JSON.stringify(workflow), JSON.stringify(nodeMapping), body.enabled === undefined ? prior.enabled : body.enabled, id]);
    if (!result.affectedRows) { await connection.rollback(); return jsonResponse({ error: "workflow_not_found" }, 404); }
    await connection.execute("INSERT INTO audit_events (id,actor_type,action,target_id,created_at) VALUES (?,'admin','workflow.updated',?,UTC_TIMESTAMP(3))", [randomUUID(), id]);
    const [updated] = await connection.execute<RowDataPacket[]>("SELECT id,name,version,workflow,node_mapping AS nodeMapping,enabled,created_at AS createdAt,updated_at AS updatedAt FROM workflow_configs WHERE id=?", [id]);
    await connection.commit();
    return jsonResponse({ workflow: mapWorkflowConfig(updated[0]) });
  } catch (error) { await connection.rollback(); console.error("Admin workflow update failed", error instanceof Error ? error.message : "unknown error"); return jsonResponse({ error: "service_unavailable" }, 503); } finally { connection.release(); }
}
