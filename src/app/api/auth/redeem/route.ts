import { allowInvitationAttempt, hashSecret, redeemInvitation, sessionCookie } from "@/lib/auth";
import { isRecord, jsonResponse, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  return request.headers.get("sec-fetch-site") !== "cross-site";
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);

  try {
    const forwardedFor = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
    const address = request.headers.get("x-real-ip")?.trim() || forwardedFor || "unknown";
    if (!await allowInvitationAttempt(`invite-ip:${hashSecret(address)}`, 10, 15)) {
      return jsonResponse({ error: "rate_limited" }, 429, { "retry-after": "900" });
    }
    const body: unknown = await readJson(request, 2048);
    if (!isRecord(body) || typeof body.code !== "string") {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    const result = await redeemInvitation(body.code);
    return jsonResponse({ userId: result.userId }, 200, {
      "set-cookie": sessionCookie(result.token, result.expiresAt),
    });
  } catch (error) {
    if (error instanceof Error && ["INVITATION_INVALID", "BODY_TOO_LARGE", "INVALID_JSON"].includes(error.message)) {
      const status = error.message === "BODY_TOO_LARGE" ? 413 : error.message === "INVALID_JSON" ? 400 : 401;
      return jsonResponse({ error: error.message.toLowerCase() }, status);
    }
    console.error("Invitation redemption failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
