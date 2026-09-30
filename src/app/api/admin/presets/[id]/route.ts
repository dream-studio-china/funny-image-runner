import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
import { getStoredPresets, recordPresetUpdate } from "@/lib/preset-store";
import { hasRequiredPresetPrompts, hasValidPresetNodeMapping } from "@/lib/preset-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
type PresetUpdate = {
  name: string;
  subtitle: string;
  description: string;
  image: string;
  tint: string;
  accent: string;
  tag: string;
  promptLabel: string;
  promptPlaceholder: string;
  moods: string[];
  enabled: boolean;
  categoryId?: string | null;
  coverAssetId?: string | null;
  workflow?: Record<string, unknown> | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  additional?: Record<string, unknown> | null;
  nodeMapping?: Record<string, unknown> | null;
  workflowConfigId?: string | null;
};

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function validatePreset(value: unknown): value is PresetUpdate {
  return isRecord(value) &&
    typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 100 &&
    typeof value.subtitle === "string" && value.subtitle.trim().length > 0 && value.subtitle.length <= 100 &&
    typeof value.description === "string" && value.description.length <= 500 &&
    typeof value.image === "string" && (/^\/art\/[a-z0-9-]+\.svg$/.test(value.image) || (value.image === "" && typeof value.coverAssetId === "string")) &&
    isHexColor(value.tint) && isHexColor(value.accent) &&
    typeof value.tag === "string" && value.tag.length <= 40 &&
    typeof value.promptLabel === "string" && value.promptLabel.length <= 100 &&
    typeof value.promptPlaceholder === "string" && value.promptPlaceholder.length <= 200 &&
    Array.isArray(value.moods) && value.moods.length > 0 && value.moods.length <= 8 &&
    value.moods.every((mood) => typeof mood === "string" && mood.trim().length > 0 && mood.length <= 40) &&
    typeof value.enabled === "boolean" &&
    (value.categoryId === undefined || value.categoryId === null || (typeof value.categoryId === "string" && /^[a-z0-9][a-z0-9-]{1,79}$/.test(value.categoryId))) &&
    (value.coverAssetId === undefined || value.coverAssetId === null || typeof value.coverAssetId === "string") &&
    (value.workflowConfigId === undefined || value.workflowConfigId === null || (typeof value.workflowConfigId === "string" && /^[a-z0-9][a-z0-9-]{1,79}$/.test(value.workflowConfigId))) &&
    [value.workflow, value.additional, value.nodeMapping].every((item) => item === undefined || item === null || (isRecord(item) && JSON.stringify(item).length <= 100_000)) &&
    [value.prompt, value.negativePrompt].every((item) => item === undefined || item === null || (typeof item === "string" && item.length <= 20_000));
}

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  let body: unknown;
  try {
    body = await readJson(request, 200_000);
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  if (!validatePreset(body)) return jsonResponse({ error: "invalid_preset" }, 400);
  if (body.enabled && body.workflowConfigId === null) return jsonResponse({ error: "workflow_config_required" }, 400);
  if (body.workflowConfigId === undefined && body.enabled && (!body.workflow || Object.keys(body.workflow).length === 0)) return jsonResponse({ error: "workflow_required" }, 400);
  if (body.workflowConfigId === undefined && body.workflow && Object.keys(body.workflow).length > 0 && !hasValidPresetNodeMapping(body.workflow, body.nodeMapping, body.prompt, body.negativePrompt)) return jsonResponse({ error: "invalid_node_mapping" }, 400);

  const { id } = await params;
  try {
    const pool = getPool();
    const connection = await pool.getConnection();
    let result;
    try {
      await connection.beginTransaction();
      const nextCategoryId = body.categoryId === undefined ? "general" : body.categoryId;
      if (nextCategoryId !== null) {
        const [categoryRows] = await connection.execute("SELECT id FROM preset_categories WHERE id = ? FOR UPDATE", [nextCategoryId]);
        if (!(categoryRows as unknown[]).length) { await connection.rollback(); return jsonResponse({ error: "category_not_found" }, 400); }
      }
      const [presetRows] = await connection.execute("SELECT id FROM presets WHERE id = ? FOR UPDATE", [id]);
      if (!(presetRows as unknown[]).length) { await connection.rollback(); return jsonResponse({ error: "preset_not_found" }, 404); }
      if (body.coverAssetId) {
        const [assetRows] = await connection.execute("SELECT id FROM preset_assets WHERE id=?", [body.coverAssetId]);
        if (!(assetRows as unknown[]).length) { await connection.rollback(); return jsonResponse({ error: "asset_not_found" }, 400); }
      }
      [result] = await connection.execute(
      `UPDATE presets SET version = version + 1, name = ?, subtitle = ?, description = ?, image = ?, tint = ?, accent = ?,
                          tag = ?, prompt_label = ?, prompt_placeholder = ?, moods = ?, enabled = ?, category_id=?, cover_asset_id=?, updated_at = UTC_TIMESTAMP(3)
       WHERE id = ?`,
      [body.name.trim(), body.subtitle.trim(), body.description.trim(), body.image, body.tint, body.accent,
        body.tag.trim(), body.promptLabel.trim(), body.promptPlaceholder.trim(), JSON.stringify(body.moods), body.enabled, nextCategoryId, body.coverAssetId ?? null, id],
      );
      if ("affectedRows" in result && result.affectedRows === 0) { await connection.rollback(); return jsonResponse({ error: "preset_not_found" }, 404); }
      const [versionRows] = await connection.execute("SELECT version FROM presets WHERE id=?", [id]);
      const version = Number((versionRows as Array<{version:number}>)[0]?.version);
      const [priorRows] = await connection.execute("SELECT workflow,prompt,negative_prompt AS negativePrompt,additional,node_mapping AS nodeMapping,workflow_config_id AS workflowConfigId,workflow_config_version AS workflowConfigVersion FROM preset_versions WHERE preset_id=? AND version=?", [id, version - 1]);
      const prior = (priorRows as Array<Record<string, unknown>>)[0] ?? {};
      let configId = body.workflowConfigId === undefined ? prior.workflowConfigId == null ? null : String(prior.workflowConfigId) : body.workflowConfigId;
      let configVersion = body.workflowConfigId === undefined ? prior.workflowConfigVersion == null ? null : Number(prior.workflowConfigVersion) : null;
      if (body.workflowConfigId) {
        const [configs] = await connection.execute("SELECT id,version,workflow,node_mapping AS nodeMapping,enabled FROM workflow_configs WHERE id=? FOR UPDATE", [body.workflowConfigId]);
        const config = (configs as Array<Record<string, unknown>>)[0];
        if (!config) { await connection.rollback(); return jsonResponse({ error: "workflow_config_not_found" }, 400); }
        if (body.enabled && !Boolean(config.enabled)) { await connection.rollback(); return jsonResponse({ error: "workflow_config_disabled" }, 400); }
        const configWorkflow = typeof config.workflow === "string" ? JSON.parse(config.workflow) as unknown : config.workflow;
        const configMapping = typeof config.nodeMapping === "string" ? JSON.parse(config.nodeMapping) as unknown : config.nodeMapping;
        if (body.enabled && !hasRequiredPresetPrompts(configMapping, body.prompt ?? prior.prompt, body.negativePrompt ?? prior.negativePrompt)) { await connection.rollback(); return jsonResponse({ error: "preset_prompt_required" }, 400); }
        if (!hasValidPresetNodeMapping(configWorkflow, configMapping, body.prompt ?? prior.prompt, body.negativePrompt ?? prior.negativePrompt)) { await connection.rollback(); return jsonResponse({ error: "invalid_node_mapping" }, 400); }
        prior.workflow = configWorkflow; prior.nodeMapping = configMapping;
        configId = String(config.id); configVersion = Number(config.version);
      } else if (body.workflowConfigId === null) { configId = null; configVersion = null; }
      const val = (key: string, prev: string) => body[key as keyof PresetUpdate] === undefined ? prior[prev] ?? null : body[key as keyof PresetUpdate];
      const snapshotWorkflow = body.workflowConfigId !== undefined && body.workflowConfigId !== null ? prior.workflow : val("workflow","workflow");
      const snapshotMapping = body.workflowConfigId !== undefined && body.workflowConfigId !== null ? prior.nodeMapping : val("nodeMapping","nodeMapping");
      const versionValues = [id, version, snapshotWorkflow ? JSON.stringify(snapshotWorkflow) : null, val("prompt","prompt"), val("negativePrompt","negativePrompt"), val("additional","additional") ? JSON.stringify(val("additional","additional")) : null, snapshotMapping ? JSON.stringify(snapshotMapping) : null, configId, configVersion] as (string | number | null)[];
      await connection.execute("INSERT INTO preset_versions (preset_id,version,workflow,prompt,negative_prompt,additional,node_mapping,workflow_config_id,workflow_config_version) VALUES (?,?,?,?,?,?,?,?,?)", versionValues);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    await recordPresetUpdate(id);
    const preset = (await getStoredPresets(true)).find((item) => item.id === id);
    return preset ? jsonResponse({ preset }) : jsonResponse({ error: "preset_not_found" }, 404);
  } catch (error) {
    console.error("Admin preset update failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  const { id } = await params;
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(id)) return jsonResponse({ error: "preset_not_found" }, 404);

  let connection;
  try {
    connection = await getPool().getConnection();
    await connection.beginTransaction();
    const [presetRows] = await connection.execute("SELECT id FROM presets WHERE id = ? FOR UPDATE", [id]);
    if (!(presetRows as unknown[]).length) {
      await connection.rollback();
      return jsonResponse({ error: "preset_not_found" }, 404);
    }
    const [activeRows] = await connection.execute<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM jobs WHERE preset_id = ? AND status IN ('queued', 'running')",
      [id],
    );
    const activeJobs = Number(activeRows[0]?.total ?? 0);
    if (activeJobs > 0) {
      await connection.rollback();
      return jsonResponse({ error: "preset_in_use", activeJobs }, 409);
    }
    await connection.execute("DELETE FROM presets WHERE id = ?", [id]);
    await connection.execute(
      "INSERT INTO audit_events (id, actor_type, action, target_id, created_at) VALUES (?, 'admin', 'preset.deleted', ?, UTC_TIMESTAMP(3))",
      [randomUUID(), id],
    );
    await connection.commit();
    return jsonResponse({ deleted: true, presetId: id });
  } catch (error) {
    await connection?.rollback();
    console.error("Admin preset delete failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  } finally {
    connection?.release();
  }
}
