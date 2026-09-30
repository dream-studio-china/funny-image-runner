import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
import { getStoredPresets, recordPresetUpdate } from "@/lib/preset-store";

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
};

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function validatePreset(value: unknown): value is PresetUpdate {
  return isRecord(value) &&
    typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 100 &&
    typeof value.subtitle === "string" && value.subtitle.trim().length > 0 && value.subtitle.length <= 100 &&
    typeof value.description === "string" && value.description.length <= 500 &&
    typeof value.image === "string" && /^\/art\/[a-z0-9-]+\.svg$/.test(value.image) &&
    isHexColor(value.tint) && isHexColor(value.accent) &&
    typeof value.tag === "string" && value.tag.length <= 40 &&
    typeof value.promptLabel === "string" && value.promptLabel.length <= 100 &&
    typeof value.promptPlaceholder === "string" && value.promptPlaceholder.length <= 200 &&
    Array.isArray(value.moods) && value.moods.length > 0 && value.moods.length <= 8 &&
    value.moods.every((mood) => typeof mood === "string" && mood.trim().length > 0 && mood.length <= 40) &&
    typeof value.enabled === "boolean";
}

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  if (request.headers.has("cookie") && !isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  let body: unknown;
  try {
    body = await readJson(request, 16_384);
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  if (!validatePreset(body)) return jsonResponse({ error: "invalid_preset" }, 400);

  const { id } = await params;
  try {
    const [result] = await getPool().execute(
      `UPDATE presets SET version = version + 1, name = ?, subtitle = ?, description = ?, image = ?, tint = ?, accent = ?,
                          tag = ?, prompt_label = ?, prompt_placeholder = ?, moods = ?, enabled = ?, updated_at = UTC_TIMESTAMP(3)
       WHERE id = ?`,
      [body.name.trim(), body.subtitle.trim(), body.description.trim(), body.image, body.tint, body.accent,
        body.tag.trim(), body.promptLabel.trim(), body.promptPlaceholder.trim(), JSON.stringify(body.moods), body.enabled, id],
    );
    if ("affectedRows" in result && result.affectedRows === 0) return jsonResponse({ error: "preset_not_found" }, 404);
    await recordPresetUpdate(id);
    const preset = (await getStoredPresets(true)).find((item) => item.id === id);
    return preset ? jsonResponse({ preset }) : jsonResponse({ error: "preset_not_found" }, 404);
  } catch (error) {
    console.error("Admin preset update failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
