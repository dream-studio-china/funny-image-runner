import { getPresetCategories, getStoredPresets, signedCoverVariant } from "@/lib/preset-store";
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
      return {...category,image:signedCoverVariant(coverKey, { mode: 1, width: 320, height: 96, quality: 70 }) ?? (fallback ? signedCoverVariant(fallback.coverKey, { mode: 1, width: 320, height: 96, quality: 70 }) ?? fallback.image : null)};
    });
    return jsonResponse({ categories, presets: presets.map(({ id, version, name, subtitle, description, image, tint, accent, tag, promptLabel, promptPlaceholder, moods, categoryId, coverKey }) => ({
      id, version, name, subtitle, description,
      image: signedCoverVariant(coverKey, { mode: 1, width: 480, height: 396, quality: 74 }) ?? image,
      galleryImage: signedCoverVariant(coverKey, { mode: 1, width: 480, height: 585, quality: 76 }) ?? image,
      sampleImage: signedCoverVariant(coverKey, { mode: 1, width: 400, height: 400, quality: 72 }) ?? image,
      previewImage: signedCoverVariant(coverKey, { mode: 2, width: 1100, height: 900, quality: 84 }) ?? image,
      tint, accent, tag, promptLabel, promptPlaceholder, moods, categoryId,
    })) });
  } catch (error) {
    console.error("Preset list query failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
