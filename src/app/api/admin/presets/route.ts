import { isAdminRequest } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/http";
import { getPresetCategories, getStoredPresets, signedCover } from "@/lib/preset-store";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, readJson } from "@/lib/http";
import { randomUUID } from "node:crypto";
import { hasValidPresetNodeMapping } from "@/lib/preset-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
    const presets = await getStoredPresets(true);
    const categories = await getPresetCategories(true);
    return jsonResponse({ categories: categories.map(({coverKey,...category})=>({...category,coverAssetId:category.coverAssetId == null ? null : String(category.coverAssetId),image:signedCover(coverKey)})), presets: presets.map((preset) => ({
      id: preset.id,
      version: preset.version,
      name: preset.name,
      subtitle: preset.subtitle,
       description: preset.description,
       image: preset.image,
       coverImage: signedCover(preset.coverKey),
      coverAssetId: preset.coverAssetId,
      categoryId: preset.categoryId,
      tint: preset.tint,
      accent: preset.accent,
      tag: preset.tag,
      promptLabel: preset.promptLabel,
      promptPlaceholder: preset.promptPlaceholder,
      moods: preset.moods,
      enabled: preset.enabled,
      updatedAt: preset.updatedAt,
      workflow: preset.workflow, prompt: preset.prompt, negativePrompt: preset.negativePrompt,
      additional: preset.additional, nodeMapping: preset.nodeMapping,
    })) });
  } catch (error) {
    console.error("Admin preset list failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try { if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401); } catch { return jsonResponse({ error: "service_unavailable" }, 503); }
  let body: unknown;
  try { body = await readJson(request, 200_000); } catch { return jsonResponse({ error: "invalid_json" }, 400); }
  if (!isRecord(body) || typeof body.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(body.id) || typeof body.name !== "string" || !body.name.trim() || body.name.length > 100 || typeof body.categoryId !== "string" || typeof body.coverAssetId !== "string" || !Array.isArray(body.moods) || body.moods.length < 1 || body.moods.length > 8 || body.moods.some((mood) => typeof mood !== "string" || !mood.trim() || mood.length > 40)) return jsonResponse({ error: "invalid_preset" }, 400);
  const workflow = body.workflow;
  const executable = isRecord(workflow) && Object.keys(workflow).length > 0;
  if (body.enabled === true && !executable) return jsonResponse({ error: "workflow_required" }, 400);
  if (executable && !hasValidPresetNodeMapping(workflow, body.nodeMapping, body.prompt, body.negativePrompt)) return jsonResponse({ error: "invalid_node_mapping" }, 400);
  const jsonFields = [workflow, body.additional, body.nodeMapping];
  if (jsonFields.some((value) => value !== undefined && value !== null && (!isRecord(value) || JSON.stringify(value).length > 100_000))) return jsonResponse({ error: "invalid_workflow_config" }, 400);
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [cats] = await conn.execute("SELECT id FROM preset_categories WHERE id=?", [body.categoryId]);
    if (!(cats as unknown[]).length) { await conn.rollback(); return jsonResponse({ error: "category_not_found" }, 400); }
    const [assets] = await conn.execute("SELECT id FROM preset_assets WHERE id=?", [body.coverAssetId]);
    if (!(assets as unknown[]).length) { await conn.rollback(); return jsonResponse({ error: "asset_not_found" }, 400); }
    await conn.execute("INSERT INTO presets (id,version,name,subtitle,description,image,tint,accent,tag,prompt_label,prompt_placeholder,moods,enabled,category_id,cover_asset_id,updated_at) VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?, ?,?,UTC_TIMESTAMP(3))", [body.id, body.name.trim(), typeof body.subtitle === "string" ? body.subtitle.slice(0,100) : "", typeof body.description === "string" ? body.description.slice(0,500) : "", typeof body.image === "string" ? body.image : "", typeof body.tint === "string" ? body.tint : "#eeeeee", typeof body.accent === "string" ? body.accent : "#333333", typeof body.tag === "string" ? body.tag.slice(0,40) : "", typeof body.promptLabel === "string" ? body.promptLabel.slice(0,100) : "", typeof body.promptPlaceholder === "string" ? body.promptPlaceholder.slice(0,200) : "", JSON.stringify(Array.isArray(body.moods) ? body.moods.filter((item): item is string => typeof item === "string").slice(0,8) : []), Boolean(body.enabled), body.categoryId, typeof body.coverAssetId === "string" ? body.coverAssetId : null]);
    await conn.execute("INSERT INTO preset_versions (preset_id,version,workflow,prompt,negative_prompt,additional,node_mapping) VALUES (?,1,?,?,?,?,?)", [body.id, workflow ? JSON.stringify(workflow) : null, typeof body.prompt === "string" ? body.prompt : null, typeof body.negativePrompt === "string" ? body.negativePrompt : null, body.additional ? JSON.stringify(body.additional) : null, body.nodeMapping ? JSON.stringify(body.nodeMapping) : null]);
    await conn.execute("INSERT INTO audit_events (id,actor_type,action,target_id,created_at) VALUES (?,'admin','preset.created',?,UTC_TIMESTAMP(3))", [randomUUID(),body.id]);
    await conn.commit();
    return jsonResponse({ preset: (await getStoredPresets(true)).find((preset) => preset.id === body.id) }, 201);
  } catch (error) { await conn.rollback(); if ((error as { code?: string }).code === "ER_DUP_ENTRY") return jsonResponse({ error: "preset_exists" }, 409); console.error("Admin preset create failed", error instanceof Error ? error.message : "unknown error"); return jsonResponse({ error: "service_unavailable" }, 503); } finally { conn.release(); }
}
