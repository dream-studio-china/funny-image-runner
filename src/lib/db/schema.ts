import { sql } from "drizzle-orm";
import {
  char,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const createdAt = () => datetime("created_at", { mode: "date", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`);

export const users = mysqlTable("users", {
  id: varchar("id", { length: 64 }).primaryKey(),
  createdAt: createdAt(),
  disabledAt: datetime("disabled_at", { mode: "date", fsp: 3 }),
});

export const invitations = mysqlTable("invitations", {
  id: char("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => users.id),
  batchId: varchar("batch_id", { length: 80 }).notNull(),
  ordinal: int("ordinal").notNull(),
  codeHash: char("code_hash", { length: 64 }).notNull(),
  createdAt: createdAt(),
  expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }),
  redeemedAt: datetime("redeemed_at", { mode: "date", fsp: 3 }),
}, (table) => [
  uniqueIndex("invitations_code_hash_uq").on(table.codeHash),
  uniqueIndex("invitations_batch_ordinal_uq").on(table.batchId, table.ordinal),
  index("invitations_user_idx").on(table.userId),
]);

export const sessions = mysqlTable("sessions", {
  id: char("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => users.id),
  tokenHash: char("token_hash", { length: 64 }).notNull(),
  createdAt: createdAt(),
  expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
  revokedAt: datetime("revoked_at", { mode: "date", fsp: 3 }),
}, (table) => [
  uniqueIndex("sessions_token_hash_uq").on(table.tokenHash),
  index("sessions_user_idx").on(table.userId),
]);

export const authRateLimits = mysqlTable("auth_rate_limits", {
  keyHash: char("key_hash", { length: 64 }).primaryKey(),
  attempts: int("attempts").notNull().default(0),
  resetAt: datetime("reset_at", { mode: "date", fsp: 3 }).notNull(),
});

export const uploads = mysqlTable("uploads", {
  id: char("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => users.id),
  objectKey: varchar("object_key", { length: 512 }).notNull(),
  contentType: varchar("content_type", { length: 100 }).notNull(),
  declaredSize: int("declared_size").notNull(),
  expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
  consumedJobId: char("consumed_job_id", { length: 36 }),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("uploads_object_key_uq").on(table.objectKey),
  uniqueIndex("uploads_consumed_job_uq").on(table.consumedJobId),
  index("uploads_user_created_idx").on(table.userId, table.createdAt),
]);

export const jobs = mysqlTable("jobs", {
  id: char("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => users.id),
  uploadId: char("upload_id", { length: 36 }).notNull().references(() => uploads.id),
  idempotencyKey: char("idempotency_key", { length: 36 }).notNull(),
  requestHash: char("request_hash", { length: 64 }).notNull(),
  presetId: varchar("preset_id", { length: 80 }).notNull(),
  presetVersion: int("preset_version").notNull(),
  parameters: json("parameters").$type<Record<string, string>>().notNull(),
  status: mysqlEnum("status", ["queued", "running", "succeeded", "failed"]).notNull().default("queued"),
  phase: varchar("phase", { length: 40 }),
  attempts: int("attempts").notNull().default(0),
  leaseTokenHash: char("lease_token_hash", { length: 64 }),
  leaseUntil: datetime("lease_until", { mode: "date", fsp: 3 }),
  promptId: char("prompt_id", { length: 36 }),
  errorCode: varchar("error_code", { length: 80 }),
  createdAt: createdAt(),
  updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  finishedAt: datetime("finished_at", { mode: "date", fsp: 3 }),
}, (table) => [
  uniqueIndex("jobs_upload_uq").on(table.uploadId),
  uniqueIndex("jobs_user_idempotency_uq").on(table.userId, table.idempotencyKey),
  uniqueIndex("jobs_prompt_id_uq").on(table.promptId),
  index("jobs_user_created_idx").on(table.userId, table.createdAt, table.id),
  index("jobs_claim_idx").on(table.status, table.leaseUntil, table.createdAt),
]);

export const jobOutputs = mysqlTable("job_outputs", {
  jobId: char("job_id", { length: 36 }).notNull().references(() => jobs.id),
  index: int("output_index").notNull(),
  objectKey: varchar("object_key", { length: 512 }).notNull(),
  contentType: varchar("content_type", { length: 100 }).notNull(),
  size: int("size").notNull(),
}, (table) => [
  uniqueIndex("job_outputs_job_index_uq").on(table.jobId, table.index),
  uniqueIndex("job_outputs_object_key_uq").on(table.objectKey),
]);

export const auditEvents = mysqlTable("audit_events", {
  id: char("id", { length: 36 }).primaryKey(),
  actorType: mysqlEnum("actor_type", ["admin", "user", "worker", "system"]).notNull(),
  actorId: varchar("actor_id", { length: 128 }),
  action: varchar("action", { length: 100 }).notNull(),
  targetId: varchar("target_id", { length: 128 }),
  metadata: text("metadata"),
  createdAt: createdAt(),
}, (table) => [index("audit_events_created_idx").on(table.createdAt)]);
