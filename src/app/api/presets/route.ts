import { presets } from "@/lib/presets";
import { jsonResponse } from "@/lib/http";

export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  return jsonResponse({ presets: presets.map(({ id, version, name, subtitle, description, image, tint, accent, tag, promptLabel, promptPlaceholder, moods }) => ({
    id, version, name, subtitle, description, image, tint, accent, tag, promptLabel, promptPlaceholder, moods,
  })) });
}
