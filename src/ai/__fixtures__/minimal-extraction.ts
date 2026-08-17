/**
 * Test-only helpers. Builds the smallest instance the extraction schema accepts,
 * so specs can exercise validation without hand-writing 125 properties across
 * 21 enum-constrained fields.
 */
import { EXTRACTION_SCHEMA } from '../schema';

export type SchemaNode = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: boolean | SchemaNode;
};

export function minimalValid(node: SchemaNode): unknown {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (node.enum) {
    return node.enum.includes(null) ? null : node.enum[0];
  }
  if (types.includes('null')) return null;
  if (types.includes('object')) {
    if (!node.properties) return {};
    const built: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node.properties)) {
      built[key] = minimalValid(child);
    }
    return built;
  }
  if (types.includes('array')) return [];
  if (types.includes('string')) return 'x';
  if (types.includes('integer') || types.includes('number')) return 0;
  if (types.includes('boolean')) return false;
  return null;
}

/** A complete, schema-conformant extraction. */
export function minimalExtraction(): Record<string, unknown> {
  const instance = minimalValid(
    EXTRACTION_SCHEMA as SchemaNode,
  ) as Record<string, unknown>;
  instance.full_text = 'the document text';
  return instance;
}

/** What the model returns: the same thing without full_text. */
export function minimalModelOutput(): Record<string, unknown> {
  const instance = minimalExtraction();
  delete instance.full_text;
  return instance;
}
