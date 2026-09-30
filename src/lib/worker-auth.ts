import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";
import { jsonResponse, readJson } from "@/lib/http";

export const LEASE_SECONDS = 90;
export const MAX_ATTEMPT_SECONDS = 20 * 60;
export const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const MAX_OUTPUTS = 4;

export function authorized(request: Request): boolean {
  const expected = process.env.WORKER_TOKEN;
  const supplied = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function rejectUnauthorized(): Response { return jsonResponse({ error: "unauthorized" }, 401); }
export function badRequest(error = "invalid_request"): Response { return jsonResponse({ error }, 400); }
export function unavailable(): Response { return jsonResponse({ error: "service_unavailable" }, 503); }

export async function workerBody(request: Request, limit = 16_384): Promise<Record<string, unknown> | null> {
  const value = await readJson(request, limit);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function hashLease(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function newLeaseToken(): string { return randomUUID(); }

export async function withinRateLimit(request: Request, endpoint: string, limit = 60): Promise<boolean> {
  const bearer = request.headers.get("authorization") ?? "";
  const keyHash = createHash("sha256").update(`worker-rate:${endpoint}:${bearer}`).digest("hex");
  const pool = getPool();
  await pool.execute(
    `INSERT INTO auth_rate_limits (key_hash,attempts,reset_at) VALUES (?,1,UTC_TIMESTAMP(3) + INTERVAL 1 MINUTE)
     ON DUPLICATE KEY UPDATE attempts=IF(reset_at<=UTC_TIMESTAMP(3),1,attempts+1),
       reset_at=IF(reset_at<=UTC_TIMESTAMP(3),UTC_TIMESTAMP(3) + INTERVAL 1 MINUTE,reset_at)`, [keyHash],
  );
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT attempts FROM auth_rate_limits WHERE key_hash=?", [keyHash]);
  return Number(rows[0]?.attempts ?? limit + 1) <= limit;
}

export async function lockLease(connection: PoolConnection, id: string, token: unknown): Promise<RowDataPacket | null> {
  if (typeof token !== "string" || !/^[0-9a-f-]{36}$/i.test(token)) return null;
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id,status,attempts,prompt_id AS promptId,phase,lease_until AS leaseUntil,
            lease_token_hash AS leaseTokenHash,created_at AS createdAt
     FROM jobs WHERE id=? FOR UPDATE`, [id],
  );
  const job = rows[0];
  if (!job || job.status !== "running" || job.leaseTokenHash !== hashLease(token)) return null;
  const [valid] = await connection.execute<RowDataPacket[]>("SELECT (lease_until > UTC_TIMESTAMP(3) AND updated_at > UTC_TIMESTAMP(3) - INTERVAL 20 MINUTE) AS valid FROM jobs WHERE id=?", [id]);
  return Number(valid[0]?.valid) === 1 ? job : null;
}

export async function parseWorkerBody(request: Request, limit?: number): Promise<Record<string, unknown> | Response> {
  try {
    const parsed = await workerBody(request, limit);
    return parsed ?? badRequest();
  } catch (error) {
    return badRequest(error instanceof Error && error.message === "BODY_TOO_LARGE" ? "body_too_large" : "invalid_json");
  }
}
