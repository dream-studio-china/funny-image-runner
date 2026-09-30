import "server-only";
import type { RowDataPacket } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/db";
import { presets as defaults, type Preset } from "@/lib/presets";
import { createPrivateDownloadUrl, createPrivateImageViewUrl } from "@/lib/qiniu";

export type StoredPreset = Preset & { enabled: boolean; workerConfig: Record<string, unknown> | null; updatedAt: string; categoryId: string | null; coverAssetId: string | null; coverKey: string | null; workflow: Record<string, unknown> | null; prompt: string | null; negativePrompt: string | null; additional: Record<string, unknown> | null; nodeMapping: Record<string, unknown> | null; workflowConfigId: string | null; workflowConfigVersion: number | null };

async function ensureSeeded(): Promise<void> {
  const pool = getPool();
  await pool.execute("INSERT INTO preset_categories (id,name,sort_order,enabled) VALUES ('general','全部风格',0,1) ON DUPLICATE KEY UPDATE id=id");
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM presets");
  if (Number(rows[0]?.total ?? 0) > 0) return;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const preset of defaults) {
      await connection.execute(`INSERT INTO presets (id,version,name,subtitle,description,image,tint,accent,tag,prompt_label,prompt_placeholder,moods,enabled,category_id,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,'general',UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id=id`,
      [preset.id,preset.version,preset.name,preset.subtitle,preset.description,preset.image,preset.tint,preset.accent,preset.tag,preset.promptLabel,preset.promptPlaceholder,JSON.stringify(preset.moods)]);
      await connection.execute("INSERT IGNORE INTO preset_versions (preset_id,version,workflow) VALUES (?,?,NULL)", [preset.id,preset.version]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

function obj(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown; } catch { return null; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function mapPreset(row: RowDataPacket): StoredPreset {
  const moods = typeof row.moods === "string" ? JSON.parse(row.moods) as unknown : row.moods;
  return { id:String(row.id), version:Number(row.version), name:String(row.name), subtitle:String(row.subtitle), description:String(row.description), image:String(row.image), tint:String(row.tint), accent:String(row.accent), tag:String(row.tag), promptLabel:String(row.promptLabel), promptPlaceholder:String(row.promptPlaceholder), moods:Array.isArray(moods) ? moods.filter((item): item is string => typeof item === "string") : [], enabled:Boolean(row.enabled), workerConfig:obj(row.workflow), workflow:obj(row.workflow), prompt:row.prompt == null ? null : String(row.prompt), negativePrompt:row.negativePrompt == null ? null : String(row.negativePrompt), additional:obj(row.additional), nodeMapping:obj(row.nodeMapping), workflowConfigId:row.workflowConfigId == null ? null : String(row.workflowConfigId), workflowConfigVersion:row.workflowConfigVersion == null ? null : Number(row.workflowConfigVersion), categoryId:row.categoryId == null ? null : String(row.categoryId), coverAssetId:row.coverAssetId == null ? null : String(row.coverAssetId), coverKey:row.coverKey == null ? null : String(row.coverKey), updatedAt:new Date(row.updatedAt).toISOString() };
}
const select = `SELECT p.id,p.version,p.name,p.subtitle,p.description,p.image,p.tint,p.accent,p.tag,p.prompt_label AS promptLabel,p.prompt_placeholder AS promptPlaceholder,p.moods,p.enabled,p.category_id AS categoryId,p.cover_asset_id AS coverAssetId,p.updated_at AS updatedAt,v.workflow,v.prompt,v.negative_prompt AS negativePrompt,v.additional,v.node_mapping AS nodeMapping,v.workflow_config_id AS workflowConfigId,v.workflow_config_version AS workflowConfigVersion,a.object_key AS coverKey FROM presets p LEFT JOIN preset_versions v ON v.preset_id=p.id AND v.version=p.version LEFT JOIN preset_assets a ON a.id=p.cover_asset_id`;
export async function getStoredPresets(includeDisabled = false): Promise<StoredPreset[]> {
  await ensureSeeded();
  const [rows] = await getPool().execute<RowDataPacket[]>(`${select} ${includeDisabled ? "" : "WHERE p.enabled=1 AND (p.category_id IS NULL OR EXISTS (SELECT 1 FROM preset_categories c WHERE c.id=p.category_id AND c.enabled=1)) AND (v.workflow_config_id IS NULL OR EXISTS (SELECT 1 FROM workflow_configs w WHERE w.id=v.workflow_config_id AND w.enabled=1))"} ORDER BY p.name,p.id`);
  return rows.map(mapPreset);
}
export async function getPresetCategories(includeDisabled = false): Promise<RowDataPacket[]> {
  await ensureSeeded();
  const [rows] = await getPool().execute<RowDataPacket[]>(`SELECT c.id,c.name,c.cover_asset_id AS coverAssetId,a.object_key AS coverKey,c.sort_order AS sortOrder,c.enabled FROM preset_categories c LEFT JOIN preset_assets a ON a.id=c.cover_asset_id ${includeDisabled ? "" : "WHERE c.enabled=1"} ORDER BY c.sort_order,c.id`);
  return rows;
}
export function signedCover(key: unknown): string | null { return typeof key === "string" && key ? createPrivateDownloadUrl(key, 3600) : null; }
export function signedCoverVariant(key: unknown, options: { mode: 1 | 2; width: number; height: number; quality?: number }): string | null {
  return typeof key === "string" && key
    ? createPrivateImageViewUrl(key, { ...options, quality: options.quality ?? 74, format: "webp" }, 3600)
    : null;
}
export async function recordPresetUpdate(id: string): Promise<void> { await getPool().execute("INSERT INTO audit_events (id,actor_type,action,target_id,created_at) VALUES (?,'admin','preset.updated',?,UTC_TIMESTAMP(3))", [randomUUID(),id]); }
