import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
import { getPresetCategories, signedCover } from "@/lib/preset-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try { if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401); const categories=await getPresetCategories(true); return jsonResponse({ categories: categories.map(({coverKey,...category})=>({...category,coverAssetId:category.coverAssetId == null ? null : String(category.coverAssetId),image:signedCover(coverKey)})) }); }
  catch { return jsonResponse({ error: "service_unavailable" }, 503); }
}
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try { if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401); } catch { return jsonResponse({ error: "service_unavailable" }, 503); }
  let b: unknown; try { b = await readJson(request,4096); } catch { return jsonResponse({ error: "invalid_json" },400); }
    if (!isRecord(b) || typeof b.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(b.id) || typeof b.name !== "string" || !b.name.trim() || b.name.length > 100 || (b.sortOrder !== undefined && !Number.isInteger(b.sortOrder)) || (b.enabled !== undefined && typeof b.enabled !== "boolean") || typeof b.coverAssetId !== "string") return jsonResponse({ error: "invalid_category" },400);
  const id=b.id; const name=b.name.trim(); const sortOrder=typeof b.sortOrder === "number" ? b.sortOrder : 0; const enabled=b.enabled !== false;
   try { const coverAssetId=typeof b.coverAssetId === "string" ? b.coverAssetId : null; if(coverAssetId){const [assets]=await getPool().execute("SELECT id FROM preset_assets WHERE id=?",[coverAssetId]);if(!(assets as unknown[]).length)return jsonResponse({error:"asset_not_found"},400);} await getPool().execute("INSERT INTO preset_categories (id,name,cover_asset_id,sort_order,enabled) VALUES (?,?,?,?,?)",[id,name,coverAssetId,sortOrder,enabled]); return jsonResponse({ category: { id,name,coverAssetId,sortOrder,enabled } },201); }
  catch (e) { return jsonResponse({ error:(e as {code?:string}).code === "ER_DUP_ENTRY" ? "category_exists" : "service_unavailable" },(e as {code?:string}).code === "ER_DUP_ENTRY" ? 409 : 503); }
}
