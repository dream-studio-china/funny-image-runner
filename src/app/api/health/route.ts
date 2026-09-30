import { getPool } from "@/lib/db";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await getPool().query("SELECT 1");
    return jsonResponse({ status: "ok", database: "ok" });
  } catch {
    return jsonResponse({ status: "degraded", database: "unavailable" }, 503);
  }
}
