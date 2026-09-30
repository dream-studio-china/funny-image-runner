import { getSessionUser } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await getSessionUser(request.headers.get("cookie"));
    return user ? jsonResponse({ userId: user.id }) : jsonResponse({ error: "unauthorized" }, 401);
  } catch (error) {
    console.error("Session lookup failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
