import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{id:string}> };
export async function PATCH(request: Request, {params}: Context): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({error:"origin_not_allowed"},403);
  try { if (!await isAdminRequest(request)) return jsonResponse({error:"unauthorized"},401); } catch { return jsonResponse({error:"service_unavailable"},503); }
  let b: unknown; try { b=await readJson(request,4096); } catch { return jsonResponse({error:"invalid_json"},400); }
   if (!isRecord(b) || (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim() || b.name.length>100)) || (b.enabled !== undefined && typeof b.enabled !== "boolean") || (b.sortOrder !== undefined && !Number.isInteger(b.sortOrder)) || (b.coverAssetId !== undefined && b.coverAssetId !== null && typeof b.coverAssetId !== "string")) return jsonResponse({error:"invalid_category"},400);
  const {id}=await params;
   const name=typeof b.name === "string" ? b.name.trim() : null; const enabled=typeof b.enabled === "boolean" ? b.enabled : null; const sortOrder=typeof b.sortOrder === "number" ? b.sortOrder : null;
   try { const pool=getPool(); if(typeof b.coverAssetId === "string"){const [assets]=await pool.execute("SELECT id FROM preset_assets WHERE id=?",[b.coverAssetId]);if(!(assets as unknown[]).length)return jsonResponse({error:"asset_not_found"},400);} const fields: string[]=[]; const values: (string|number|boolean|null)[]=[]; if(name!==null){fields.push("name=?");values.push(name);} if(enabled!==null){fields.push("enabled=?");values.push(enabled);} if(sortOrder!==null){fields.push("sort_order=?");values.push(sortOrder);} if(b.coverAssetId!==undefined){fields.push("cover_asset_id=?");values.push(b.coverAssetId as string|null);} fields.push("updated_at=UTC_TIMESTAMP(3)"); values.push(id); const [r]=await pool.execute(`UPDATE preset_categories SET ${fields.join(",")} WHERE id=?`,values); return (r as {affectedRows:number}).affectedRows ? jsonResponse({ok:true}) : jsonResponse({error:"category_not_found"},404); }
  catch { return jsonResponse({error:"service_unavailable"},503); }
}
