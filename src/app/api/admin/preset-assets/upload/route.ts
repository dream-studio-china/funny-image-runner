import { randomUUID } from "node:crypto";
import { isAdminRequest } from "@/lib/admin-auth";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
import { createUploadCredential, isAllowedImageType } from "@/lib/qiniu";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({error:"origin_not_allowed"},403);
  try { if (!await isAdminRequest(request)) return jsonResponse({error:"unauthorized"},401); } catch { return jsonResponse({error:"service_unavailable"},503); }
  let b: unknown; try { b=await readJson(request,4096); } catch { return jsonResponse({error:"invalid_json"},400); }
  if (!isRecord(b) || typeof b.contentType !== "string" || !isAllowedImageType(b.contentType) || typeof b.size !== "number" || !Number.isInteger(b.size) || b.size<1 || b.size>5*1024*1024) return jsonResponse({error:"invalid_upload"},400);
  try { const key=`preset-covers/${randomUUID()}`; const credential=createUploadCredential(key,5*1024*1024); return jsonResponse({key,...credential,maxBytes:5*1024*1024}); } catch { return jsonResponse({error:"storage_unavailable"},503); }
}
