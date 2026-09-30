import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { isRecord, isSameOriginRequest, jsonResponse, readJson } from "@/lib/http";
import { getStoredPresets } from "@/lib/preset-store";
import type { StoredPreset } from "@/lib/preset-store";
import { verifyUploadedObject } from "@/lib/qiniu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreateJobBody = {
  uploadId: string;
  presetId: string;
  parameters: Record<string, string>;
  idempotencyKey: string;
};

type ExistingJob = RowDataPacket & { id: string; requestHash: string; status: string; presetId: string; presetVersion: number };

function parseBody(value: unknown, availablePresets: StoredPreset[]): CreateJobBody | null {
  if (!isRecord(value) || !/^[0-9a-f-]{36}$/i.test(String(value.uploadId ?? "")) ||
      !/^[0-9a-f-]{36}$/i.test(String(value.idempotencyKey ?? "")) || typeof value.presetId !== "string" || !isRecord(value.parameters)) return null;
  const preset = availablePresets.find((item) => item.id === value.presetId);
  if (!preset) return null;
  const parameters: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.parameters)) {
    if (key === "mood" && typeof item === "string" && preset.moods.includes(item)) parameters.mood = item;
    else if (key === "note" && typeof item === "string" && item.length <= 120) parameters.note = item.trim();
    else return null;
  }
  if (!parameters.mood) return null;
  return { uploadId: value.uploadId as string, idempotencyKey: value.idempotencyKey as string, presetId: preset.id, parameters };
}

function digestBody(body: CreateJobBody, presetVersion: number): string {
  const canonical = JSON.stringify({
    uploadId: body.uploadId,
    presetId: body.presetId,
    presetVersion,
    parameters: Object.fromEntries(Object.entries(body.parameters).sort(([left], [right]) => left.localeCompare(right))),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function responseFor(job: ExistingJob, status: number): Response {
  return jsonResponse({ id: job.id, status: job.status, presetId: job.presetId, presetVersion: job.presetVersion }, status);
}

async function findIdempotentJob(connection: PoolConnection, userId: string, idempotencyKey: string): Promise<ExistingJob | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id, request_hash AS requestHash, status, preset_id AS presetId, preset_version AS presetVersion
     FROM jobs WHERE user_id = ? AND idempotency_key = ? LIMIT 1`,
    [userId, idempotencyKey],
  );
  return (rows[0] as ExistingJob | undefined) ?? null;
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return jsonResponse({ error: "origin_not_allowed" }, 403);
  let user;
  try {
    user = await getSessionUser(request.headers.get("cookie"));
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  let availablePresets: StoredPreset[];
  try {
    availablePresets = await getStoredPresets();
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }

  let body: CreateJobBody | null;
  try {
    body = parseBody(await readJson(request, 16_384), availablePresets);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "BODY_TOO_LARGE";
    return jsonResponse({ error: tooLarge ? "body_too_large" : "invalid_json" }, tooLarge ? 413 : 400);
  }
  if (!body) return jsonResponse({ error: "invalid_job" }, 400);

  const preset = availablePresets.find((item) => item.id === body.presetId)!;
  if (!preset.workflow || Object.keys(preset.workflow).length === 0) {
    return jsonResponse({ error: "preset_not_ready" }, 409);
  }
  const requestHash = digestBody(body, preset.version);
  const connection = await getPool().getConnection().catch(() => null);
  if (!connection) return jsonResponse({ error: "service_unavailable" }, 503);
  let transactionOpen = false;
  try {
    const existing = await findIdempotentJob(connection, user.id, body.idempotencyKey);
    if (existing) return existing.requestHash === requestHash ? responseFor(existing, 200) : jsonResponse({ error: "idempotency_conflict" }, 409);

    const [uploads] = await connection.execute<RowDataPacket[]>(
      `SELECT id, object_key AS objectKey, content_type AS contentType, declared_size AS declaredSize, deleted_at AS deletedAt,
               expires_at AS expiresAt, consumed_job_id AS consumedJobId
       FROM uploads WHERE id = ? AND user_id = ? LIMIT 1`,
      [body.uploadId, user.id],
    );
    const upload = uploads[0];
    if (!upload) return jsonResponse({ error: "upload_not_found" }, 404);
    if (upload.deletedAt) return jsonResponse({ error: "upload_deleted" }, 410);
    if (upload.consumedJobId) return jsonResponse({ error: "upload_already_used" }, 409);
    if (new Date(upload.expiresAt) <= new Date()) return jsonResponse({ error: "upload_expired" }, 410);

    try {
      await verifyUploadedObject(upload.objectKey as string, Number(upload.declaredSize), upload.contentType as string);
    } catch (error) {
      if (error instanceof Error && error.message === "QINIU_OBJECT_NOT_FOUND") return jsonResponse({ error: "upload_not_found_in_storage" }, 422);
      if (error instanceof Error && error.message === "QINIU_OBJECT_MISMATCH") return jsonResponse({ error: "upload_object_mismatch" }, 422);
      console.error("Upload verification failed", error instanceof Error ? error.message : "unknown error");
      return jsonResponse({ error: "storage_unavailable" }, 503);
    }

    await connection.beginTransaction();
    transactionOpen = true;
    const [presetRows] = await connection.execute<RowDataPacket[]>("SELECT id FROM presets WHERE id = ? FOR UPDATE", [preset.id]);
    if (!presetRows[0]) {
      await connection.rollback();
      transactionOpen = false;
      return jsonResponse({ error: "preset_not_found" }, 409);
    }
    const [userRows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, account_expires_at AS accountExpiresAt, total_job_limit AS totalJobLimit,
              daily_job_limit AS dailyJobLimit
       FROM users WHERE id = ? AND disabled_at IS NULL FOR UPDATE`,
      [user.id],
    );
    if (!userRows[0]) {
      await connection.rollback();
      transactionOpen = false;
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    if (userRows[0].accountExpiresAt && new Date(userRows[0].accountExpiresAt) <= new Date()) {
      await connection.rollback();
      transactionOpen = false;
      return jsonResponse({ error: "account_expired" }, 403);
    }
    const retried = await findIdempotentJob(connection, user.id, body.idempotencyKey);
    if (retried) {
      await connection.rollback();
      transactionOpen = false;
      return retried.requestHash === requestHash ? responseFor(retried, 200) : jsonResponse({ error: "idempotency_conflict" }, 409);
    }

    const [activeRows] = await connection.execute<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')",
      [user.id],
    );
    if (Number(activeRows[0]?.total ?? 0) >= 1) {
      await connection.rollback();
      transactionOpen = false;
      return jsonResponse({ error: "active_job_limit" }, 429);
    }
    await connection.execute("INSERT INTO system_settings (id, total_job_limit, daily_job_limit) VALUES (1, NULL, 10) ON DUPLICATE KEY UPDATE id = id");
    const [settingsRows] = await connection.execute<RowDataPacket[]>(
      "SELECT total_job_limit AS totalJobLimit, daily_job_limit AS dailyJobLimit FROM system_settings WHERE id = 1",
    );
    const settings = settingsRows[0] ?? { totalJobLimit: null, dailyJobLimit: 10 };
    const totalJobLimit = userRows[0].totalJobLimit === null ? settings.totalJobLimit : userRows[0].totalJobLimit;
    const dailyJobLimit = userRows[0].dailyJobLimit === null ? Number(settings.dailyJobLimit ?? 10) : Number(userRows[0].dailyJobLimit);
    const [totalRows] = await connection.execute<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM jobs WHERE user_id = ?",
      [user.id],
    );
    if (totalJobLimit !== null && Number(totalRows[0]?.total ?? 0) >= Number(totalJobLimit)) {
      await connection.rollback();
      transactionOpen = false;
      return jsonResponse({ error: "total_job_limit" }, 429);
    }
    const [dailyRows] = await connection.execute<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM jobs WHERE user_id = ? AND created_at >= UTC_DATE()",
      [user.id],
    );
    if (Number(dailyRows[0]?.total ?? 0) >= dailyJobLimit) {
      await connection.rollback();
      transactionOpen = false;
      return jsonResponse({ error: "daily_job_limit" }, 429);
    }

    const [lockedUploads] = await connection.execute<RowDataPacket[]>(
      `SELECT id, consumed_job_id AS consumedJobId, expires_at AS expiresAt
       FROM uploads WHERE id = ? AND user_id = ? FOR UPDATE`,
      [body.uploadId, user.id],
    );
    if (!lockedUploads[0] || lockedUploads[0].consumedJobId || new Date(lockedUploads[0].expiresAt) <= new Date()) {
      await connection.rollback();
      transactionOpen = false;
      return jsonResponse({ error: "upload_unavailable" }, 409);
    }

    const jobId = randomUUID();
    await connection.execute(
      `INSERT INTO jobs (id, user_id, upload_id, idempotency_key, request_hash, preset_id, preset_version,
                         parameters, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      [jobId, user.id, body.uploadId, body.idempotencyKey, requestHash, preset.id, preset.version, JSON.stringify(body.parameters)],
    );
    await connection.execute("UPDATE uploads SET consumed_job_id = ? WHERE id = ? AND consumed_job_id IS NULL", [jobId, body.uploadId]);
    await connection.commit();
    transactionOpen = false;
    return jsonResponse({ id: jobId, status: "queued", presetId: preset.id, presetVersion: preset.version }, 201);
  } catch (error) {
    if (transactionOpen) await connection.rollback();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
      return jsonResponse({ error: "idempotency_conflict" }, 409);
    }
    console.error("Job creation failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  } finally {
    connection.release();
  }
}

export async function GET(request: Request): Promise<Response> {
  let user;
  try {
    user = await getSessionUser(request.headers.get("cookie"));
  } catch {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  const limit = Math.floor(Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20)));
  try {
    const [rows] = await getPool().execute<RowDataPacket[]>(
      `SELECT id, preset_id AS presetId, preset_version AS presetVersion, status, error_code AS errorCode,
              created_at AS createdAt, finished_at AS finishedAt
       FROM jobs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
      [user.id],
    );
    return jsonResponse({ jobs: rows });
  } catch (error) {
    console.error("Job list query failed", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
}
