import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
import { createPrivateImageViewUrl, deletePrivateObject } from "@/lib/qiniu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ImageKind = "input" | "output" | "cover";
type ImageRow = RowDataPacket & {
  imageId: string; kind: ImageKind; userId: string | null; jobId: string | null;
  presetId: string | null; presetName: string | null; categoryName: string | null;
  jobStatus: string | null; contentType: string; size: number; objectKey: string;
  createdAt: Date | string; deletedAt: Date | string | null; coverReferences: string | null;
};

const IMAGE_ROWS_SQL = `
  SELECT CONVERT(CONCAT('input:',u.id) USING utf8mb4) COLLATE utf8mb4_bin AS imageId,
         CONVERT('input' USING utf8mb4) COLLATE utf8mb4_bin AS kind,
         CONVERT(u.user_id USING utf8mb4) COLLATE utf8mb4_bin AS userId,
         CONVERT(j.id USING utf8mb4) COLLATE utf8mb4_bin AS jobId,
         CONVERT(j.preset_id USING utf8mb4) COLLATE utf8mb4_bin AS presetId,
         CONVERT(p.name USING utf8mb4) COLLATE utf8mb4_bin AS presetName,
         CONVERT(c.name USING utf8mb4) COLLATE utf8mb4_bin AS categoryName,
         CONVERT(j.status USING utf8mb4) COLLATE utf8mb4_bin AS jobStatus,
         CONVERT(u.content_type USING utf8mb4) COLLATE utf8mb4_bin AS contentType,
         u.declared_size AS size,CONVERT(u.object_key USING utf8mb4) COLLATE utf8mb4_bin AS objectKey,
         u.created_at AS createdAt,u.deleted_at AS deletedAt,
         CAST(NULL AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_bin AS coverReferences
  FROM uploads u LEFT JOIN jobs j ON j.upload_id=u.id
  LEFT JOIN presets p ON p.id=j.preset_id LEFT JOIN preset_categories c ON c.id=p.category_id
  UNION ALL
  SELECT CONVERT(CONCAT('output:',o.job_id,':',o.output_index) USING utf8mb4) COLLATE utf8mb4_bin AS imageId,
         CONVERT('output' USING utf8mb4) COLLATE utf8mb4_bin AS kind,
         CONVERT(j.user_id USING utf8mb4) COLLATE utf8mb4_bin AS userId,
         CONVERT(j.id USING utf8mb4) COLLATE utf8mb4_bin AS jobId,
         CONVERT(j.preset_id USING utf8mb4) COLLATE utf8mb4_bin AS presetId,
         CONVERT(p.name USING utf8mb4) COLLATE utf8mb4_bin AS presetName,
         CONVERT(c.name USING utf8mb4) COLLATE utf8mb4_bin AS categoryName,
         CONVERT(j.status USING utf8mb4) COLLATE utf8mb4_bin AS jobStatus,
         CONVERT(o.content_type USING utf8mb4) COLLATE utf8mb4_bin AS contentType,
         o.size AS size,CONVERT(o.object_key USING utf8mb4) COLLATE utf8mb4_bin AS objectKey,
         j.finished_at AS createdAt,o.deleted_at AS deletedAt,
         CAST(NULL AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_bin AS coverReferences
  FROM job_outputs o JOIN jobs j ON j.id=o.job_id
  LEFT JOIN presets p ON p.id=j.preset_id LEFT JOIN preset_categories c ON c.id=p.category_id
  UNION ALL
  SELECT CONVERT(CONCAT('cover:',a.id) USING utf8mb4) COLLATE utf8mb4_bin AS imageId,
         CONVERT('cover' USING utf8mb4) COLLATE utf8mb4_bin AS kind,
         CAST(NULL AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_bin AS userId,
         CAST(NULL AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_bin AS jobId,
         CAST(NULL AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_bin AS presetId,
         CONVERT('展示封面' USING utf8mb4) COLLATE utf8mb4_bin AS presetName,
         CAST(NULL AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_bin AS categoryName,
         CAST(NULL AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_bin AS jobStatus,
         CONVERT(a.content_type USING utf8mb4) COLLATE utf8mb4_bin AS contentType,
         a.size AS size,CONVERT(a.object_key USING utf8mb4) COLLATE utf8mb4_bin AS objectKey,
         a.created_at AS createdAt,a.deleted_at AS deletedAt,
         CONVERT(CONCAT_WS('；',
           (SELECT GROUP_CONCAT(CONCAT('风格：',p.name) SEPARATOR '、') FROM presets p WHERE p.cover_asset_id=a.id),
           (SELECT GROUP_CONCAT(CONCAT('分类：',c.name) SEPARATOR '、') FROM preset_categories c WHERE c.cover_asset_id=a.id)
         ) USING utf8mb4) COLLATE utf8mb4_bin AS coverReferences
  FROM preset_assets a`;

function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }

function parseFilters(url: URL) {
  const kind = url.searchParams.get("kind") ?? "all";
  if (!(["all", "input", "output", "cover"] as string[]).includes(kind)) throw new Error("invalid_kind");
  const user = (url.searchParams.get("user") ?? "").trim().slice(0, 64);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if ((from && !validDate(from)) || (to && !validDate(to))) throw new Error("invalid_date");
  const minSize = Number(url.searchParams.get("minSize") ?? 0);
  const maxSize = Number(url.searchParams.get("maxSize") ?? 0);
  if ((minSize && (!Number.isSafeInteger(minSize) || minSize < 0)) || (maxSize && (!Number.isSafeInteger(maxSize) || maxSize < 0))) throw new Error("invalid_size");
  const sort = url.searchParams.get("sort") ?? "createdAt";
  if (!(["createdAt", "size", "userId"] as string[]).includes(sort)) throw new Error("invalid_sort");
  const direction = (url.searchParams.get("direction") ?? "desc").toLowerCase();
  if (direction !== "asc" && direction !== "desc") throw new Error("invalid_sort");
  const includeDeleted = url.searchParams.get("includeDeleted") === "true";
  const limit = Math.floor(Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 36) || 36)));
  const offset = Math.floor(Math.min(100_000, Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0)));
  return { kind, user, from, to, minSize, maxSize, sort, direction, includeDeleted, limit, offset };
}

function filterSql(filters: ReturnType<typeof parseFilters>): { where: string; values: Array<string | number> } {
  const clauses = ["1=1"];
  const values: Array<string | number> = [];
  if (filters.kind !== "all") { clauses.push("kind=?"); values.push(filters.kind); }
  if (filters.user) { clauses.push("userId LIKE ?"); values.push(`%${filters.user}%`); }
  if (filters.from) { clauses.push("createdAt>=?"); values.push(`${filters.from} 00:00:00`); }
  if (filters.to) {
    const next = new Date(`${filters.to}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    clauses.push("createdAt<?"); values.push(next.toISOString().slice(0, 19).replace("T", " "));
  }
  if (filters.minSize) { clauses.push("size>=?"); values.push(filters.minSize); }
  if (filters.maxSize) { clauses.push("size<=?"); values.push(filters.maxSize); }
  if (!filters.includeDeleted) clauses.push("deletedAt IS NULL");
  return { where: clauses.join(" AND "), values };
}

export async function GET(request: Request): Promise<Response> {
  try { if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401); }
  catch { return jsonResponse({ error: "service_unavailable" }, 503); }
  let filters: ReturnType<typeof parseFilters>;
  try { filters = parseFilters(new URL(request.url)); }
  catch (error) { return jsonResponse({ error: error instanceof Error ? error.message : "invalid_filter" }, 400); }
  const filter = filterSql(filters);
  const sortColumn = filters.sort === "size" ? "size" : filters.sort === "userId" ? "userId" : "createdAt";
  try {
    const pool = getPool();
    const [counts] = await pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM (${IMAGE_ROWS_SQL}) images WHERE ${filter.where}`, filter.values);
    const [rows] = await pool.execute<ImageRow[]>(
      `SELECT * FROM (${IMAGE_ROWS_SQL}) images WHERE ${filter.where}
       ORDER BY ${sortColumn} ${filters.direction.toUpperCase()},createdAt DESC,imageId LIMIT ${filters.limit} OFFSET ${filters.offset}`,
      filter.values,
    );
    return jsonResponse({
      total: Number(counts[0]?.total ?? 0), limit: filters.limit, offset: filters.offset,
      images: rows.map((row) => ({
        id: row.imageId, kind: row.kind, userId: row.userId, jobId: row.jobId,
        presetId: row.presetId, presetName: row.presetName, categoryName: row.categoryName,
        jobStatus: row.jobStatus, contentType: row.contentType, size: Number(row.size),
        storageKey: row.objectKey, createdAt: row.createdAt, deletedAt: row.deletedAt,
        coverReferences: row.coverReferences,
        thumbnailUrl: row.deletedAt ? null : createPrivateImageViewUrl(row.objectKey, { mode: 1, width: 480, height: 416, quality: 74, format: "webp" }, 3600),
        previewUrl: row.deletedAt ? null : createPrivateImageViewUrl(row.objectKey, { mode: 2, width: 1600, height: 1400, quality: 86, format: "webp" }, 3600),
      })),
    });
  } catch (error) {
    console.error("Admin image gallery failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}

type DeleteTarget = { id: string; kind: ImageKind; sourceId: string; outputIndex?: number };
function parseImageId(value: unknown): DeleteTarget | null {
  if (typeof value !== "string") return null;
  const input = value.match(/^input:([0-9a-f-]{36})$/i);
  if (input) return { id: value, kind: "input", sourceId: input[1] };
  const output = value.match(/^output:([0-9a-f-]{36}):(\d+)$/i);
  if (output) return { id: value, kind: "output", sourceId: output[1], outputIndex: Number(output[2]) };
  const cover = value.match(/^cover:([0-9a-f-]{36})$/i);
  if (cover) return { id: value, kind: "cover", sourceId: cover[1] };
  return null;
}

type DeleteCandidate = { target: DeleteTarget; objectKey: string; activeJob: boolean; referenced: boolean; alreadyDeleted: boolean };
async function findDeleteCandidates(targets: DeleteTarget[]): Promise<DeleteCandidate[]> {
  const found: DeleteCandidate[] = [];
  const pool = getPool();
  for (const target of targets) {
    let rows: RowDataPacket[];
    if (target.kind === "input") {
      [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT u.object_key AS objectKey,u.deleted_at AS deletedAt,
                (j.status IN ('queued','running')) AS activeJob
         FROM uploads u LEFT JOIN jobs j ON j.upload_id=u.id WHERE u.id=? LIMIT 1`, [target.sourceId]);
    } else if (target.kind === "output") {
      [rows] = await pool.execute<RowDataPacket[]>("SELECT object_key AS objectKey,deleted_at AS deletedAt,0 AS activeJob FROM job_outputs WHERE job_id=? AND output_index=? LIMIT 1", [target.sourceId, target.outputIndex!]);
    } else {
      [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT a.object_key AS objectKey,a.deleted_at AS deletedAt,
          EXISTS(SELECT 1 FROM presets p WHERE p.cover_asset_id=a.id) OR EXISTS(SELECT 1 FROM preset_categories c WHERE c.cover_asset_id=a.id) AS referenced
         FROM preset_assets a WHERE a.id=? LIMIT 1`, [target.sourceId]);
    }
    const row = rows[0];
    if (row) found.push({ target, objectKey: String(row.objectKey), activeJob: Boolean(row.activeJob), referenced: Boolean(row.referenced), alreadyDeleted: Boolean(row.deletedAt) });
  }
  return found;
}

async function markDeleted(target: DeleteTarget): Promise<void> {
  if (target.kind === "input") await getPool().execute("UPDATE uploads SET deleted_at=UTC_TIMESTAMP(3) WHERE id=? AND deleted_at IS NULL", [target.sourceId]);
  else if (target.kind === "output") await getPool().execute("UPDATE job_outputs SET deleted_at=UTC_TIMESTAMP(3) WHERE job_id=? AND output_index=? AND deleted_at IS NULL", [target.sourceId, target.outputIndex!]);
  else await getPool().execute("UPDATE preset_assets SET deleted_at=UTC_TIMESTAMP(3) WHERE id=? AND deleted_at IS NULL", [target.sourceId]);
}

export async function DELETE(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  try { if (!await isAdminRequest(request)) return jsonResponse({ error: "unauthorized" }, 401); }
  catch { return jsonResponse({ error: "service_unavailable" }, 503); }
  let body: unknown;
  try { body = await readJson(request, 32_768); }
  catch (error) { return jsonResponse({ error: error instanceof Error && error.message === "BODY_TOO_LARGE" ? "body_too_large" : "invalid_json" }, 400); }
  if (!isRecord(body)) return jsonResponse({ error: "invalid_request" }, 400);

  let targets: DeleteTarget[] = [];
  if (Array.isArray(body.ids) && body.ids.length > 0 && body.ids.length <= 100) {
    const parsed = body.ids.map(parseImageId);
    if (parsed.some((target) => target === null)) return jsonResponse({ error: "invalid_image_ids" }, 400);
    targets = parsed as DeleteTarget[];
  } else if (typeof body.before === "string" && validDate(body.before)) {
    const kind = typeof body.kind === "string" ? body.kind : "all";
    if (!(["all", "input", "output", "cover"] as string[]).includes(kind)) return jsonResponse({ error: "invalid_kind" }, 400);
    const filters = parseFilters(new URL(`http://local/?kind=${kind}&to=${body.before}&user=${encodeURIComponent(typeof body.user === "string" ? body.user.slice(0,64) : "")}&includeDeleted=false&limit=100`));
    const where = filterSql(filters);
    const [rows] = await getPool().execute<ImageRow[]>(`SELECT * FROM (${IMAGE_ROWS_SQL}) images WHERE ${where.where} ORDER BY createdAt,imageId LIMIT ${filters.limit}`, where.values);
    targets = rows.map((row) => parseImageId(row.imageId)).filter((target): target is DeleteTarget => Boolean(target));
  } else {
    return jsonResponse({ error: "provide_ids_or_before" }, 400);
  }

  try {
    const candidates = await findDeleteCandidates(targets);
    let deleted = 0;
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const candidate of candidates) {
      if (candidate.alreadyDeleted) { skipped.push({ id: candidate.target.id, reason: "already_deleted" }); continue; }
      if (candidate.activeJob) { skipped.push({ id: candidate.target.id, reason: "job_active" }); continue; }
      if (candidate.target.kind === "cover" && candidate.referenced) { skipped.push({ id: candidate.target.id, reason: "cover_in_use" }); continue; }
      await deletePrivateObject(candidate.objectKey);
      await markDeleted(candidate.target);
      await getPool().execute("INSERT INTO audit_events (id,actor_type,action,target_id,metadata,created_at) VALUES (?,'admin','image.deleted',?,?,UTC_TIMESTAMP(3))", [randomUUID(), candidate.target.id, JSON.stringify({ kind: candidate.target.kind })]);
      deleted++;
    }
    return jsonResponse({ deleted, skipped, requested: targets.length });
  } catch (error) {
    console.error("Admin image deletion failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "image_delete_failed" }, 503);
  }
}
