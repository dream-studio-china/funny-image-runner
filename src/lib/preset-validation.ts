import { isRecord } from "@/lib/http";

type NodeReference = { nodeId: string; inputName: string };

function isNodeReference(value: unknown): value is NodeReference {
  return isRecord(value) && typeof value.nodeId === "string" && typeof value.inputName === "string";
}

export function hasValidPresetNodeMapping(
  workflow: unknown,
  nodeMapping: unknown,
  prompt: unknown,
  negativePrompt: unknown,
): boolean {
  if (!isRecord(workflow) || !isRecord(nodeMapping)) return false;
  const nodes = workflow as Record<string, unknown>;
  const exists = (reference: unknown) => {
    if (!isNodeReference(reference)) return false;
    const node = nodes[reference.nodeId];
    return isRecord(node) && isRecord(node.inputs) && Object.hasOwn(node.inputs, reference.inputName);
  };

  if (!exists(nodeMapping.inputImage)) return false;
  if (!Array.isArray(nodeMapping.outputNodeIds) || nodeMapping.outputNodeIds.length === 0 ||
      !nodeMapping.outputNodeIds.every((id) => typeof id === "string" && Object.hasOwn(nodes, id))) return false;
  if (typeof prompt === "string" && prompt.trim() && !exists(nodeMapping.prompt)) return false;
  if (typeof negativePrompt === "string" && negativePrompt.trim() && !exists(nodeMapping.negativePrompt)) return false;
  if (nodeMapping.additional !== undefined && (!isRecord(nodeMapping.additional) ||
      Object.values(nodeMapping.additional).some((reference) => !exists(reference)))) return false;
  return true;
}
