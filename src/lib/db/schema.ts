import { sql } from "drizzle-orm";
import {
  char,
  datetime,
  boolean,
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
  totalJobLimit: int("total_job_limit"),
  dailyJobLimit: int("daily_job_limit"),
  accountExpiresAt: datetime("account_expires_at", { mode: "date", fsp: 3 }),
  accountExpiryInitialized: boolean("account_expiry_initialized").notNull().default(false),
});

export const systemSettings = mysqlTable("system_settings", {
  id: int("id").primaryKey().default(1),
  totalJobLimit: int("total_job_limit"),
  dailyJobLimit: int("daily_job_limit").notNull().default(10),
  updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const invitations = mysqlTable("invitations", {
  id: char("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => users.id),
  batchId: varchar("batch_id", { length: 80 }).notNull(),
  ordinal: int("ordinal").notNull(),
  codeHash: char("code_hash", { length: 64 }).notNull(),
  createdAt: createdAt(),
  expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }),
  accountTtlMinutes: int("account_ttl_minutes"),
  redeemedAt: datetime("redeemed_at", { mode: "date", fsp: 3 }),
  revokedAt: datetime("revoked_at", { mode: "date", fsp: 3 }),
  issueSource: varchar("issue_source", { length: 32 }),
  sourceRef: char("source_ref", { length: 64 }),
  codeCiphertext: text("code_ciphertext"),
}, (table) => [
  uniqueIndex("invitations_code_hash_uq").on(table.codeHash),
  uniqueIndex("invitations_batch_ordinal_uq").on(table.batchId, table.ordinal),
  uniqueIndex("invitations_source_ref_uq").on(table.issueSource, table.sourceRef),
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

export const adminSessions = mysqlTable("admin_sessions", {
  id: char("id", { length: 36 }).primaryKey(),
  tokenHash: char("token_hash", { length: 64 }).notNull(),
  createdAt: createdAt(),
  expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
  revokedAt: datetime("revoked_at", { mode: "date", fsp: 3 }),
}, (table) => [uniqueIndex("admin_sessions_token_hash_uq").on(table.tokenHash)]);

export const presets = mysqlTable("presets", {
  id: varchar("id", { length: 80 }).primaryKey(),
  version: int("version").notNull().default(1),
  name: varchar("name", { length: 100 }).notNull(),
  subtitle: varchar("subtitle", { length: 100 }).notNull(),
  description: varchar("description", { length: 500 }).notNull(),
  image: varchar("image", { length: 500 }).notNull(),
  tint: char("tint", { length: 7 }).notNull(),
  accent: char("accent", { length: 7 }).notNull(),
  tag: varchar("tag", { length: 40 }).notNull(),
  promptLabel: varchar("prompt_label", { length: 100 }).notNull(),
  promptPlaceholder: varchar("prompt_placeholder", { length: 200 }).notNull(),
  moods: json("moods").$type<string[]>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  workerConfig: json("worker_config").$type<Record<string, unknown> | null>(),
  categoryId: varchar("category_id", { length: 80 }).notNull().default("general"),
  coverAssetId: char("cover_asset_id", { length: 36 }),
  updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const presetCategories = mysqlTable("preset_categories", {
  id: varchar("id", { length: 80 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  coverAssetId: char("cover_asset_id", { length: 36 }),
  sortOrder: int("sort_order").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (table) => [index("preset_categories_order_idx").on(table.sortOrder, table.id)]);

export const presetAssets = mysqlTable("preset_assets", {
  id: char("id", { length: 36 }).primaryKey(),
  objectKey: varchar("object_key", { length: 512 }).notNull(),
  contentType: varchar("content_type", { length: 100 }).notNull(),
  size: int("size").notNull(),
  createdAt: createdAt(),
  deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
}, (table) => [uniqueIndex("preset_assets_object_key_uq").on(table.objectKey)]);

export const presetVersions = mysqlTable("preset_versions", {
  presetId: varchar("preset_id", { length: 80 }).notNull(),
  version: int("version").notNull(),
  workflow: json("workflow").$type<Record<string, unknown> | null>(),
  prompt: text("prompt"),
  negativePrompt: text("negative_prompt"),
  additional: json("additional").$type<Record<string, unknown> | null>(),
  nodeMapping: json("node_mapping").$type<Record<string, unknown> | null>(),
  workflowConfigId: varchar("workflow_config_id", { length: 80 }),
  workflowConfigVersion: int("workflow_config_version"),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("preset_versions_id_version_uq").on(table.presetId, table.version)]);

export const workflowConfigs = mysqlTable("workflow_configs", {
  id: varchar("id", { length: 80 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  version: int("version").notNull().default(1),
  workflow: json("workflow").$type<Record<string, unknown>>().notNull(),
  nodeMapping: json("node_mapping").$type<Record<string, unknown>>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const workers = mysqlTable("workers", {
  id: varchar("id", { length: 128 }).primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  state: mysqlEnum("state", ["starting", "idle", "processing", "stopping"]).notNull(),
  currentJobId: char("current_job_id", { length: 36 }),
  lastError: varchar("last_error", { length: 80 }),
  startedAt: datetime("started_at", { mode: "date", fsp: 3 }).notNull(),
  lastSeenAt: datetime("last_seen_at", { mode: "date", fsp: 3 }).notNull(),
}, (table) => [index("workers_last_seen_idx").on(table.lastSeenAt)]);

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
  deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
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
  deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
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
