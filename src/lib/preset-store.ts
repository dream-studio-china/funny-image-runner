import "server-only";
import type { RowDataPacket } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/db";
import { presets as defaults, type Preset } from "@/lib/presets";

export type StoredPreset = Preset & { enabled: boolean; workerConfig: Record<string, unknown> | null; updatedAt: string };

async function ensureSeeded(): Promise<void> {
  const [rows] = await getPool().execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM presets");
  if (Number(rows[0]?.total ?? 0) > 0) return;

  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    for (const preset of defaults) {
      await connection.execute(
        `INSERT INTO presets
         (id, version, name, subtitle, description, image, tint, accent, tag, prompt_label, prompt_placeholder, moods, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE id = id`,
        [preset.id, preset.version, preset.name, preset.subtitle, preset.description, preset.image, preset.tint, preset.accent, preset.tag, preset.promptLabel, preset.promptPlaceholder, JSON.stringify(preset.moods)],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function mapPreset(row: RowDataPacket): StoredPreset {
  const moods = typeof row.moods === "string" ? JSON.parse(row.moods) as unknown : row.moods as unknown;
  return {
    id: String(row.id),
    version: Number(row.version),
    name: String(row.name),
    subtitle: String(row.subtitle),
    description: String(row.description),
    image: String(row.image),
    tint: String(row.tint),
    accent: String(row.accent),
    tag: String(row.tag),
    promptLabel: String(row.promptLabel),
    promptPlaceholder: String(row.promptPlaceholder),
    moods: Array.isArray(moods) ? moods.filter((item): item is string => typeof item === "string") : [],
    enabled: Boolean(row.enabled),
    workerConfig: row.workerConfig && typeof row.workerConfig === "object" ? row.workerConfig as Record<string, unknown> : null,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function getStoredPresets(includeDisabled = false): Promise<StoredPreset[]> {
  await ensureSeeded();
  const [rows] = await getPool().execute<RowDataPacket[]>(
    `SELECT id, version, name, subtitle, description, image, tint, accent, tag,
            prompt_label AS promptLabel, prompt_placeholder AS promptPlaceholder, moods, enabled,
            worker_config AS workerConfig, updated_at AS updatedAt
     FROM presets ${includeDisabled ? "" : "WHERE enabled = 1"}
     ORDER BY name, id`,
  );
  return rows.map(mapPreset);
}

export async function recordPresetUpdate(id: string): Promise<void> {
  await getPool().execute(
    "INSERT INTO audit_events (id, actor_type, action, target_id, created_at) VALUES (?, 'admin', 'preset.updated', ?, UTC_TIMESTAMP(3))",
    [randomUUID(), id],
  );
}
