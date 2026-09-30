import { getPresetCategories, getStoredPresets, signedCover } from "@/lib/preset-store";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const availablePresets = await getStoredPresets();
    const storedCategories = await getPresetCategories();
    const allowedCategories = new Set(storedCategories.map((category) => String(category.id)));
    const presets = availablePresets.filter((preset) => preset.categoryId === null || allowedCategories.has(preset.categoryId));
    const categories=storedCategories.map(({coverKey,...category})=>{
      const fallback=presets.find((preset)=>preset.categoryId===String(category.id));
      return {...category,image:signedCover(coverKey) ?? (fallback ? signedCover(fallback.coverKey) ?? fallback.image : null)};
    });
    return jsonResponse({ categories, presets: presets.map(({ id, version, name, subtitle, description, image, tint, accent, tag, promptLabel, promptPlaceholder, moods, categoryId, coverKey }) => ({
      id, version, name, subtitle, description, image: signedCover(coverKey) ?? image, tint, accent, tag, promptLabel, promptPlaceholder, moods, categoryId,
    })) });
  } catch (error) {
    console.error("Preset list query failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
