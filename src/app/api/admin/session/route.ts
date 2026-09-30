import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/db";
import { allowInvitationAttempt, hashSecret, safeEqual } from "@/lib/auth";
import { adminSessionCookie, clearAdminSessionCookie, isAdminRequest, newAdminSession, revokeAdminSession } from "@/lib/admin-auth";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    return await isAdminRequest(request) ? jsonResponse({ authenticated: true }) : jsonResponse({ authenticated: false }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  const adminToken = process.env.ADMIN_API_TOKEN;
  if (!adminToken) return jsonResponse({ error: "service_unavailable" }, 503);

  try {
    const remoteAddress = request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() || "unknown";
    if (!await allowInvitationAttempt(`admin-login:${hashSecret(remoteAddress)}`, 5, 15)) {
      return jsonResponse({ error: "rate_limited" }, 429, { "retry-after": "900" });
    }
    const body: unknown = await readJson(request, 2048);
    if (!isRecord(body) || typeof body.token !== "string" || !safeEqual(body.token, adminToken)) {
      return jsonResponse({ error: "invalid_credentials" }, 401);
    }

    const session = newAdminSession();
    await getPool().execute(
      "INSERT INTO admin_sessions (id, token_hash, created_at, expires_at) VALUES (?, ?, UTC_TIMESTAMP(3), ?)",
      [session.id, session.tokenHash, session.expiresAt],
    );
    await getPool().execute(
      "INSERT INTO audit_events (id, actor_type, action, target_id, created_at) VALUES (?, 'admin', 'admin.session.created', ?, UTC_TIMESTAMP(3))",
      [randomUUID(), session.id],
    );
    return jsonResponse({ authenticated: true, expiresAt: session.expiresAt.toISOString() }, 200, {
      "set-cookie": adminSessionCookie(session.token, session.expiresAt),
    });
  } catch (error) {
    const status = error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 503;
    return jsonResponse({ error: status === 413 ? "body_too_large" : "service_unavailable" }, status);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try {
    await revokeAdminSession(request.headers.get("cookie"));
    return jsonResponse({ ok: true }, 200, { "set-cookie": clearAdminSessionCookie() });
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503, { "set-cookie": clearAdminSessionCookie() });
  }
}
