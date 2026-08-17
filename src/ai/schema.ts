import Ajv2020, { ErrorObject } from 'ajv/dist/2020';
import strictSchema from './extraction_schema_strict.json';

/**
 * The extraction contract. The JSON file is the single source of truth for the
 * output shape — nothing in this codebase invents field names.
 */
export const EXTRACTION_SCHEMA = strictSchema;

/** The twelve top-level fields the schema requires, guarded by a test against the file. */
export const TOP_LEVEL_FIELDS = [
  'document_class',
  'sections',
  'layout',
  'prose',
  'lexicon',
  'quantitative',
  'content_rules',
  'conclusion',
  'fixed_blocks',
  'domain_specific_conventions',
  'full_text',
  'case_character',
] as const;

export type DocumentExtraction = Record<
  (typeof TOP_LEVEL_FIELDS)[number],
  unknown
> & { full_text: string };

// MODEL_SCHEMA (this schema minus full_text) lives in prompt.ts, alongside the
// prompts that reference it. This module owns validation of the finished object.

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validator = ajv.compile(EXTRACTION_SCHEMA);

/** Strips a ``` or ```json fence, which models add even when told not to. */
function stripCodeFence(raw: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(raw.trim());
  return fenced ? fenced[1] : raw;
}

/** Parses a model response into an object, with errors that say what went wrong. */
export function parseModelJson(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error('Model response was not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Model response was not a JSON object');
  }

  return parsed as Record<string, unknown>;
}

function describe(error: ErrorObject): string {
  const path = error.instancePath || '(root)';
  const extra =
    error.keyword === 'additionalProperties'
      ? ` (${String((error.params as { additionalProperty?: string }).additionalProperty)})`
      : '';
  return `${path} ${error.message ?? 'is invalid'}${extra}`;
}

/**
 * Validates against the full schema, full_text included. Throws listing every
 * violation — output that does not conform must never reach the database.
 */
export function validateExtraction(value: unknown): DocumentExtraction {
  if (validator(value)) {
    return value as DocumentExtraction;
  }

  const violations = (validator.errors ?? []).map(describe);
  throw new Error(
    `Extraction does not conform to the schema (${violations.length} violation${
      violations.length === 1 ? '' : 's'
    }): ${violations.join('; ')}`,
  );
}
