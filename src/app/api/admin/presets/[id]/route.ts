import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
import { getStoredPresets, recordPresetUpdate } from "@/lib/preset-store";
import { hasValidPresetNodeMapping } from "@/lib/preset-validation";

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
  categoryId?: string;
  coverAssetId?: string | null;
  workflow?: Record<string, unknown> | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  additional?: Record<string, unknown> | null;
  nodeMapping?: Record<string, unknown> | null;
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
    (value.categoryId === undefined || (typeof value.categoryId === "string" && /^[a-z0-9][a-z0-9-]{1,79}$/.test(value.categoryId))) &&
    (value.coverAssetId === undefined || value.coverAssetId === null || typeof value.coverAssetId === "string") &&
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
  if (body.enabled && (!body.workflow || Object.keys(body.workflow).length === 0)) return jsonResponse({ error: "workflow_required" }, 400);
  if (body.workflow && Object.keys(body.workflow).length > 0 && !hasValidPresetNodeMapping(body.workflow, body.nodeMapping, body.prompt, body.negativePrompt)) return jsonResponse({ error: "invalid_node_mapping" }, 400);

  const { id } = await params;
  try {
    const pool = getPool();
    const connection = await pool.getConnection();
    let result;
    try {
      await connection.beginTransaction();
      const [categoryRows] = await connection.execute("SELECT id FROM preset_categories WHERE id=?", [body.categoryId ?? "general"]);
      if (!(categoryRows as unknown[]).length) { await connection.rollback(); return jsonResponse({ error: "category_not_found" }, 400); }
      if (body.coverAssetId) {
        const [assetRows] = await connection.execute("SELECT id FROM preset_assets WHERE id=?", [body.coverAssetId]);
        if (!(assetRows as unknown[]).length) { await connection.rollback(); return jsonResponse({ error: "asset_not_found" }, 400); }
      }
      [result] = await connection.execute(
      `UPDATE presets SET version = version + 1, name = ?, subtitle = ?, description = ?, image = ?, tint = ?, accent = ?,
                          tag = ?, prompt_label = ?, prompt_placeholder = ?, moods = ?, enabled = ?, category_id=?, cover_asset_id=?, updated_at = UTC_TIMESTAMP(3)
       WHERE id = ?`,
      [body.name.trim(), body.subtitle.trim(), body.description.trim(), body.image, body.tint, body.accent,
        body.tag.trim(), body.promptLabel.trim(), body.promptPlaceholder.trim(), JSON.stringify(body.moods), body.enabled, body.categoryId ?? "general", body.coverAssetId ?? null, id],
      );
      if ("affectedRows" in result && result.affectedRows === 0) { await connection.rollback(); return jsonResponse({ error: "preset_not_found" }, 404); }
      const [versionRows] = await connection.execute("SELECT version FROM presets WHERE id=?", [id]);
      const version = Number((versionRows as Array<{version:number}>)[0]?.version);
      const [priorRows] = await connection.execute("SELECT workflow,prompt,negative_prompt AS negativePrompt,additional,node_mapping AS nodeMapping FROM preset_versions WHERE preset_id=? AND version=?", [id, version - 1]);
      const prior = (priorRows as Array<Record<string, unknown>>)[0] ?? {};
      const val = (key: string, prev: string) => body[key as keyof PresetUpdate] === undefined ? prior[prev] ?? null : body[key as keyof PresetUpdate];
      const versionValues = [id, version, val("workflow","workflow") ? JSON.stringify(val("workflow","workflow")) : null, val("prompt","prompt"), val("negativePrompt","negativePrompt"), val("additional","additional") ? JSON.stringify(val("additional","additional")) : null, val("nodeMapping","nodeMapping") ? JSON.stringify(val("nodeMapping","nodeMapping")) : null] as (string | number | null)[];
      await connection.execute("INSERT INTO preset_versions (preset_id,version,workflow,prompt,negative_prompt,additional,node_mapping) VALUES (?,?,?,?,?,?,?)", versionValues);
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
