import { clearedSessionCookie, revokeSession } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }
  try {
    await revokeSession(request.headers.get("cookie"));
    return jsonResponse({ ok: true }, 200, { "set-cookie": clearedSessionCookie() });
  } catch (error) {
    console.error("Session revocation failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503, { "set-cookie": clearedSessionCookie() });
  }
}
