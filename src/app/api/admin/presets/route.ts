import { isAdminRequest } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/http";
import { getStoredPresets } from "@/lib/preset-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
    const presets = await getStoredPresets(true);
    return jsonResponse({ presets: presets.map((preset) => ({
      id: preset.id,
      version: preset.version,
      name: preset.name,
      subtitle: preset.subtitle,
      description: preset.description,
      image: preset.image,
      tint: preset.tint,
      accent: preset.accent,
      tag: preset.tag,
      promptLabel: preset.promptLabel,
      promptPlaceholder: preset.promptPlaceholder,
      moods: preset.moods,
      enabled: preset.enabled,
      updatedAt: preset.updatedAt,
    })) });
  } catch (error) {
    console.error("Admin preset list failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
