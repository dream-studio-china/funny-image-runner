import { randomUUID } from "node:crypto";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
import { isAllowedImageType, verifyUploadedObject } from "@/lib/qiniu";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({error:"origin_not_allowed"},403);
  try { if (!await isAdminRequest(request)) return jsonResponse({error:"unauthorized"},401); } catch { return jsonResponse({error:"service_unavailable"},503); }
  let b: unknown; try { b=await readJson(request,4096); } catch { return jsonResponse({error:"invalid_json"},400); }
  if (!isRecord(b) || typeof b.key!=="string" || !/^preset-covers\/[0-9a-f-]{36}$/.test(b.key) || typeof b.contentType!=="string" || !isAllowedImageType(b.contentType) || typeof b.size!=="number" || !Number.isInteger(b.size) || b.size<1 || b.size>5*1024*1024) return jsonResponse({error:"invalid_asset"},400);
  try { await verifyUploadedObject(b.key,b.size,b.contentType); const id=randomUUID(); await getPool().execute("INSERT INTO preset_assets (id,object_key,content_type,size) VALUES (?,?,?,?)",[id,b.key,b.contentType,b.size]); return jsonResponse({assetId:id},201); }
  catch (e) { if (e instanceof Error && e.message === "QINIU_OBJECT_NOT_FOUND") return jsonResponse({error:"asset_not_found"},400); console.error("Preset asset confirmation failed",e instanceof Error?e.message:"unknown"); return jsonResponse({error:"asset_verification_failed"},400); }
}
