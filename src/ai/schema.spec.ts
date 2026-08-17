import {
  EXTRACTION_SCHEMA,
  TOP_LEVEL_FIELDS,
  parseModelJson,
  validateExtraction,
} from './schema';
import { MODEL_SCHEMA as RAW_MODEL_SCHEMA } from './prompt';
import { minimalExtraction } from './__fixtures__/minimal-extraction';

const MODEL_SCHEMA = RAW_MODEL_SCHEMA as {
  properties: Record<string, unknown>;
  required: string[];
};

describe('MODEL_SCHEMA', () => {
  it('omits full_text so the model never echoes the document back', () => {
    expect(MODEL_SCHEMA.properties).not.toHaveProperty('full_text');
    expect(MODEL_SCHEMA.required).not.toContain('full_text');
  });

  it('keeps every other required field', () => {
    const expected = TOP_LEVEL_FIELDS.filter((field) => field !== 'full_text');

    expect([...MODEL_SCHEMA.required].sort()).toEqual([...expected].sort());
  });

  it('leaves the validation schema untouched, full_text included', () => {
    expect(EXTRACTION_SCHEMA.properties).toHaveProperty('full_text');
    expect(EXTRACTION_SCHEMA.required).toContain('full_text');
  });
});

describe('TOP_LEVEL_FIELDS', () => {
  it('matches the schema file, so drift in the file fails here first', () => {
    expect([...TOP_LEVEL_FIELDS].sort()).toEqual(
      [...EXTRACTION_SCHEMA.required].sort(),
    );
  });
});

describe('parseModelJson', () => {
  it('parses a plain JSON object', () => {
    expect(parseModelJson('{"document_class":null}')).toEqual({
      document_class: null,
    });
  });

  it('strips a markdown code fence the model added despite instructions', () => {
    expect(parseModelJson('```json\n{"sections":[]}\n```')).toEqual({
      sections: [],
    });
  });

  it('strips an unlabelled code fence', () => {
    expect(parseModelJson('```\n{"sections":[]}\n```')).toEqual({
      sections: [],
    });
  });

  it('throws when the payload is not valid JSON', () => {
    expect(() => parseModelJson('{"truncated": ')).toThrow(/valid JSON/i);
  });

  it('throws when the payload is JSON but not an object', () => {
    expect(() => parseModelJson('[1,2,3]')).toThrow(/JSON object/i);
  });
});

describe('validateExtraction', () => {
  it('accepts an instance that conforms to the schema', () => {
    const instance = minimalExtraction();

    expect(() => validateExtraction(instance)).not.toThrow();
  });

  it('rejects an instance missing a required top-level field', () => {
    const instance = minimalExtraction();
    delete instance.sections;

    expect(() => validateExtraction(instance)).toThrow(/sections/);
  });

  it('rejects invented top-level keys, which is how the old shape leaked through', () => {
    const instance = minimalExtraction();
    instance.documentType = 'Operative Report';

    expect(() => validateExtraction(instance)).toThrow(/documentType/);
  });

  it('rejects a wrongly typed field', () => {
    const instance = minimalExtraction();
    instance.full_text = 42;

    expect(() => validateExtraction(instance)).toThrow(/full_text/);
  });

  it('reports every violation at once rather than only the first', () => {
    const instance = minimalExtraction();
    delete instance.sections;
    delete instance.prose;

    expect(() => validateExtraction(instance)).toThrow(/sections[\s\S]*prose|prose[\s\S]*sections/);
  });
});
