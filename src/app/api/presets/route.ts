import { getStoredPresets } from "@/lib/preset-store";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const availablePresets = await getStoredPresets();
    return jsonResponse({ presets: availablePresets.map(({ id, version, name, subtitle, description, image, tint, accent, tag, promptLabel, promptPlaceholder, moods }) => ({
      id, version, name, subtitle, description, image, tint, accent, tag, promptLabel, promptPlaceholder, moods,
    })) });
  } catch (error) {
    console.error("Preset list query failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
