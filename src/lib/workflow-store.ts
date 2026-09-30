import "server-only";
import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db";

export type WorkflowConfig = {
  id: string;
  name: string;
  version: number;
  workflow: Record<string, unknown>;
  nodeMapping: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === "string") value = JSON.parse(value) as unknown;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function mapWorkflowConfig(row: RowDataPacket): WorkflowConfig {
  return { id: String(row.id), name: String(row.name), version: Number(row.version), workflow: parseJson(row.workflow), nodeMapping: parseJson(row.nodeMapping), enabled: Boolean(row.enabled), createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() };
}

export async function listWorkflowConfigs(): Promise<WorkflowConfig[]> {
  const [rows] = await getPool().execute<RowDataPacket[]>("SELECT id,name,version,workflow,node_mapping AS nodeMapping,enabled,created_at AS createdAt,updated_at AS updatedAt FROM workflow_configs ORDER BY name,id");
  return rows.map(mapWorkflowConfig);
}
