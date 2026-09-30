import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  let body: unknown;
  try { body = await readJson(request, 4096); } catch { return jsonResponse({ error: "invalid_json" }, 400); }
  if (!isRecord(body) || (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100)) ||
      (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
      (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) ||
      (body.coverAssetId !== undefined && body.coverAssetId !== null && typeof body.coverAssetId !== "string")) {
    return jsonResponse({ error: "invalid_category" }, 400);
  }
  const { id } = await params;
  const name = typeof body.name === "string" ? body.name.trim() : null;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
  const sortOrder = typeof body.sortOrder === "number" ? body.sortOrder : null;
  try {
    const pool = getPool();
    if (typeof body.coverAssetId === "string") {
      const [assets] = await pool.execute("SELECT id FROM preset_assets WHERE id = ?", [body.coverAssetId]);
      if (!(assets as unknown[]).length) return jsonResponse({ error: "asset_not_found" }, 400);
    }
    const fields: string[] = [];
    const values: (string | number | boolean | null)[] = [];
    if (name !== null) { fields.push("name = ?"); values.push(name); }
    if (enabled !== null) { fields.push("enabled = ?"); values.push(enabled); }
    if (sortOrder !== null) { fields.push("sort_order = ?"); values.push(sortOrder); }
    if (body.coverAssetId !== undefined) { fields.push("cover_asset_id = ?"); values.push(body.coverAssetId as string | null); }
    fields.push("updated_at = UTC_TIMESTAMP(3)");
    values.push(id);
    const [result] = await pool.execute(`UPDATE preset_categories SET ${fields.join(", ")} WHERE id = ?`, values);
    return (result as { affectedRows: number }).affectedRows ? jsonResponse({ ok: true }) : jsonResponse({ error: "category_not_found" }, 404);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try {
    if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401);
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  const { id } = await params;
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(id)) return jsonResponse({ error: "category_not_found" }, 404);
  if (id === "general") return jsonResponse({ error: "category_protected" }, 409);

  let connection: PoolConnection | undefined;
  try {
    connection = await getPool().getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT id FROM preset_categories WHERE id = ? FOR UPDATE", [id]);
    if (!rows[0]) {
      await connection.rollback();
      return jsonResponse({ error: "category_not_found" }, 404);
    }
    const [updated] = await connection.execute(
      "UPDATE presets SET category_id = NULL, updated_at = UTC_TIMESTAMP(3) WHERE category_id = ?",
      [id],
    );
    const uncategorizedPresets = Number((updated as { affectedRows?: number }).affectedRows ?? 0);
    await connection.execute("DELETE FROM preset_categories WHERE id = ?", [id]);
    await connection.execute(
      "INSERT INTO audit_events (id, actor_type, action, target_id, metadata, created_at) VALUES (?, 'admin', 'category.deleted', ?, ?, UTC_TIMESTAMP(3))",
      [randomUUID(), id, JSON.stringify({ uncategorizedPresets })],
    );
    await connection.commit();
    return jsonResponse({ deleted: true, uncategorizedPresets });
  } catch (error) {
    await connection?.rollback();
    console.error("Admin category delete failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  } finally {
    connection?.release();
  }
}
