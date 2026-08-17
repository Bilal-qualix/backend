import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { MODEL_SCHEMA, SYSTEM_PROMPT, userPrompt } from './prompt';
import {
  DocumentExtraction,
  parseModelJson,
  validateExtraction,
} from './schema';

/**
 * Documents longer than this are truncated before being sent. Well under the
 * model's context window — format conventions are demonstrated in the first few
 * pages, so sending a whole book buys nothing and risks a context-length error.
 */
export const MAX_DOCUMENT_CHARS = 40_000;

/**
 * The schema has 12 top-level fields nested five deep, and the verbatim fields
 * quote the document at length. 2000 tokens truncates mid-object, and truncated
 * JSON surfaces as a parse error that looks like a schema problem but isn't.
 */
const MAX_OUTPUT_TOKENS = 8_000;

const REQUEST_TIMEOUT_MS = 120_000;

type ResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        strict: boolean;
        schema: Record<string, unknown>;
      };
    };

/**
 * Groq rejects json_schema on models that don't implement it, and rejects
 * schemas that strict mode can't express (open dictionaries, free-form objects).
 * Both come back as a 400 naming response_format.
 */
function isResponseFormatRejection(error: unknown): boolean {
  const { status, message } = error as {
    status?: number;
    message?: string;
    error?: { message?: string; param?: string };
  };
  if (status !== 400) return false;

  const detail = error as { error?: { message?: string; param?: string } };
  const text = `${message ?? ''} ${detail.error?.message ?? ''} ${
    detail.error?.param ?? ''
  }`;
  return /response_format|json_schema/i.test(text);
}

@Injectable()
export class GroqService {
  private readonly logger = new Logger(GroqService.name);
  private client: OpenAI | null = null;

  /** Models known to reject json_schema, so we stop paying for the failed attempt. */
  private readonly jsonObjectOnly = new Set<string>();

  /**
   * Built on first use rather than in the constructor: a missing API key should
   * fail the analysis of one file, not stop the whole app from booting.
   */
  private getClient(): OpenAI {
    if (this.client) return this.client;

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not set');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
      timeout: REQUEST_TIMEOUT_MS,
    });
    return this.client;
  }

  /** Extracts this document's format conventions, conforming to the schema. */
  async extract(documentText: string): Promise<DocumentExtraction> {
    if (documentText.trim().length === 0) {
      throw new Error('Document is empty, nothing to analyse');
    }

    const client = this.getClient();
    const model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
    const sent = this.truncate(documentText);

    let completion = null as Awaited<
      ReturnType<typeof client.chat.completions.create>
    > | null;

    if (this.jsonObjectOnly.has(model)) {
      completion = await this.request(client, model, sent, false);
    } else {
      try {
        completion = await this.request(client, model, sent, true);
      } catch (error) {
        if (!isResponseFormatRejection(error)) throw error;

        this.jsonObjectOnly.add(model);
        this.logger.warn(
          `${model} rejected response_format json_schema; falling back to ` +
            `json_object with the schema in the prompt. Nothing is enforced ` +
            `server-side in this mode, so the Ajv check is the only guarantee.`,
        );
        completion = await this.request(client, model, sent, false);
      }
    }

    const choice = completion.choices[0];

    // Checked before parsing: truncated JSON fails to parse, and the parse error
    // hides the real cause, which is the output limit.
    if (choice?.finish_reason === 'length') {
      throw new Error(
        `Model ${model} stopped at the ${MAX_OUTPUT_TOKENS}-token output limit, ` +
          `so the JSON was truncated and cannot be parsed`,
      );
    }

    const content = choice?.message?.content;
    if (!content || content.trim().length === 0) {
      throw new Error(`Model ${model} returned an empty response`);
    }

    const extraction = parseModelJson(content);

    // Assigned here, never asked of the model: the full untruncated source, so
    // full_text is the document itself rather than the model's rendering of it.
    extraction.full_text = documentText;

    return validateExtraction(extraction);
  }

  private request(
    client: OpenAI,
    model: string,
    documentText: string,
    withJsonSchema: boolean,
  ) {
    const responseFormat: ResponseFormat = withJsonSchema
      ? {
          type: 'json_schema',
          json_schema: {
            name: 'DocumentFormatExtraction',
            strict: true,
            schema: MODEL_SCHEMA as Record<string, unknown>,
          },
        }
      : { type: 'json_object' };

    // In json_object mode the schema is not passed to the API at all, so it has
    // to travel in the prompt or the model has nothing to conform to.
    const system = withJsonSchema
      ? SYSTEM_PROMPT
      : `${SYSTEM_PROMPT}\n\n## Schema\n\nConform to this JSON Schema exactly:\n${JSON.stringify(
          MODEL_SCHEMA,
        )}`;

    return client.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: responseFormat,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt(documentText) },
      ],
    });
  }

  private truncate(text: string): string {
    if (text.length <= MAX_DOCUMENT_CHARS) return text;

    this.logger.warn(
      `Document of ${text.length} chars truncated to ${MAX_DOCUMENT_CHARS} for analysis`,
    );
    return `${text.slice(0, MAX_DOCUMENT_CHARS)}\n\n[document truncated for analysis]`;
  }
}
