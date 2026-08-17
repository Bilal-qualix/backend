import { Test, TestingModule } from '@nestjs/testing';
import { GroqService, MAX_DOCUMENT_CHARS } from './groq.service';
import { SYSTEM_PROMPT } from './prompt';
import { minimalModelOutput } from './__fixtures__/minimal-extraction';

const mockCreate = jest.fn();
const mockConstructor = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: class {
    chat = { completions: { create: mockCreate } };
    constructor(options: unknown) {
      mockConstructor(options);
    }
  },
}));

interface ChatRequest {
  model: string;
  temperature: number;
  max_tokens: number;
  messages: { role: string; content: string }[];
  response_format: {
    type: string;
    json_schema?: { name: string; strict: boolean; schema: Record<string, unknown> };
  };
}

function requests(): ChatRequest[] {
  return (mockCreate.mock.calls as unknown as [ChatRequest][]).map(([arg]) => arg);
}

function lastRequest(): ChatRequest {
  const all = requests();
  if (all.length === 0) throw new Error('The API was never called');
  return all[all.length - 1];
}

function modelReplies(content: unknown, finishReason = 'stop') {
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: {
          content: typeof content === 'string' ? content : JSON.stringify(content),
        },
      },
    ],
  };
}

/** The 400 Groq returns for a model that has no json_schema support. */
function unsupportedResponseFormat() {
  return Object.assign(
    new Error('This model does not support response format `json_schema`.'),
    {
      status: 400,
      error: {
        message: 'This model does not support response format `json_schema`.',
        param: 'response_format',
      },
    },
  );
}

describe('GroqService', () => {
  let service: GroqService;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GROQ_API_KEY = 'test-key';
    process.env.GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
    process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';

    const module: TestingModule = await Test.createTestingModule({
      providers: [GroqService],
    }).compile();

    service = module.get<GroqService>(GroqService);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('the request', () => {
    beforeEach(() => {
      mockCreate.mockResolvedValue(modelReplies(minimalModelOutput()));
    });

    it('passes the schema through response_format, not just a mention in the prompt', async () => {
      await service.extract('A document');

      const format = lastRequest().response_format;
      expect(format.type).toBe('json_schema');
      expect(format.json_schema?.strict).toBe(true);
      expect(format.json_schema?.name).toBe('DocumentFormatExtraction');
      expect(Object.keys(format.json_schema?.schema.properties ?? {})).toContain(
        'document_class',
      );
    });

    it('never asks the model to echo the document back as full_text', async () => {
      await service.extract('A document');

      const schema = lastRequest().response_format.json_schema?.schema as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(schema.properties).not.toHaveProperty('full_text');
      expect(schema.required).not.toContain('full_text');
    });

    it('uses a low temperature and enough output tokens for a deep schema', async () => {
      await service.extract('A document');

      expect(lastRequest().temperature).toBe(0.1);
      expect(lastRequest().max_tokens).toBe(8000);
    });

    it('sends the system prompt and the document', async () => {
      await service.extract('The document body');

      expect(lastRequest().messages[0].content).toContain(SYSTEM_PROMPT);
      expect(lastRequest().messages[1].content).toContain('The document body');
    });

    it('truncates a document that would overflow the context window', async () => {
      await service.extract('a'.repeat(MAX_DOCUMENT_CHARS + 5_000));

      // The user message wraps the document in <document> tags, so allow for
      // that plus the truncation marker — the point is that 45k chars did not go.
      const sent = lastRequest().messages[1].content;
      expect(sent.length).toBeLessThan(MAX_DOCUMENT_CHARS + 500);
      expect(sent).toContain('truncated');
    });
  });

  describe('when the model does not support json_schema', () => {
    beforeEach(() => {
      mockCreate
        .mockRejectedValueOnce(unsupportedResponseFormat())
        .mockResolvedValue(modelReplies(minimalModelOutput()));
    });

    it('falls back to json_object and still returns the extraction', async () => {
      const result = await service.extract('A document');

      expect(requests()[1].response_format).toEqual({ type: 'json_object' });
      expect(result).toHaveProperty('document_class');
    });

    it('puts the schema in the system prompt, since nothing enforces it server-side', async () => {
      await service.extract('A document');

      const systemPrompt = requests()[1].messages[0].content;
      expect(systemPrompt).toContain('document_class');
      expect(systemPrompt).toContain('label_verbatim');
      expect(systemPrompt).not.toContain('"full_text"');
    });

    it('remembers the fallback instead of failing a request every time', async () => {
      await service.extract('First document');
      await service.extract('Second document');

      // 2 for the first (rejected attempt + fallback), 1 for the second.
      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(lastRequest().response_format).toEqual({ type: 'json_object' });
    });
  });

  describe('failures', () => {
    it('does not fall back when the API fails for an unrelated reason', async () => {
      mockCreate.mockRejectedValue(
        Object.assign(new Error('Internal server error'), { status: 500 }),
      );

      await expect(service.extract('A document')).rejects.toThrow(
        /Internal server error/,
      );
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('reports truncation clearly instead of as a parse error', async () => {
      mockCreate.mockResolvedValue(
        modelReplies('{"document_class": {"class": "operative', 'length'),
      );

      await expect(service.extract('A document')).rejects.toThrow(
        /truncated|max_tokens/i,
      );
    });

    it('refuses output that violates the schema rather than storing it', async () => {
      const invented = { documentType: 'Operative Report', tone: 'formal' };
      mockCreate.mockResolvedValue(modelReplies(invented));

      await expect(service.extract('A document')).rejects.toThrow(
        /does not conform/i,
      );
    });

    it('parses a response the model wrapped in a code fence', async () => {
      mockCreate.mockResolvedValue(
        modelReplies('```json\n' + JSON.stringify(minimalModelOutput()) + '\n```'),
      );

      await expect(service.extract('A document')).resolves.toHaveProperty(
        'document_class',
      );
    });

    it('rejects a blank document without spending an API call', async () => {
      await expect(service.extract('   \n  ')).rejects.toThrow(/empty/i);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('fails with a clear message when GROQ_API_KEY is missing', async () => {
      delete process.env.GROQ_API_KEY;

      await expect(service.extract('A document')).rejects.toThrow(/GROQ_API_KEY/);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('full_text', () => {
    it('is filled in from the source document, not from the model', async () => {
      const output = minimalModelOutput();
      output.full_text = 'a hallucinated echo of the document';
      mockCreate.mockResolvedValue(modelReplies(output));

      const result = await service.extract('The real document text');

      expect(result.full_text).toBe('The real document text');
    });

    it('holds the untruncated document even when the model saw less', async () => {
      mockCreate.mockResolvedValue(modelReplies(minimalModelOutput()));
      const long = 'a'.repeat(MAX_DOCUMENT_CHARS + 5_000);

      const result = await service.extract(long);

      expect(result.full_text).toBe(long);
    });
  });
});
