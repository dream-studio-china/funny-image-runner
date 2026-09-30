import { randomUUID } from "node:crypto";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isSameOriginRequest, jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context): Promise<Response> {
  if (request.headers.has("cookie") && !isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonResponse({ error: "invitation_not_found" }, 404);
  try {
    const [result] = await getPool().execute(
      "UPDATE invitations SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL",
      [id],
    );
    if (!("affectedRows" in result) || result.affectedRows !== 1) return jsonResponse({ error: "invitation_not_found_or_used" }, 409);
    await getPool().execute(
      "INSERT INTO audit_events (id, actor_type, action, target_id, created_at) VALUES (?, 'admin', 'invitation.revoked', ?, UTC_TIMESTAMP(3))",
      [randomUUID(), id],
    );
    return jsonResponse({ invitationId: id, revoked: true });
  } catch (error) {
    console.error("Admin invitation revocation failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
