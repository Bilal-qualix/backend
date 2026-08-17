import { Test, TestingModule } from '@nestjs/testing';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FilesService } from './files.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroqService } from '../ai/groq.service';
import { minimalExtraction } from '../ai/__fixtures__/minimal-extraction';

const prisma = {
  file: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const groq = { extract: jest.fn() };

interface UpdateArg {
  where: { id: string };
  data: Record<string, unknown>;
}

/** The update call that set the given status; throws if no such call was made. */
function updateWithStatus(status: string): UpdateArg {
  const calls = prisma.file.update.mock.calls as unknown as [UpdateArg][];
  const found = calls
    .map(([arg]) => arg)
    .find((arg) => arg.data.analysisStatus === status);

  if (!found) {
    throw new Error(`No update call set analysisStatus to ${status}`);
  }
  return found;
}

describe('FilesService', () => {
  let service: FilesService;
  let uploadDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    jest.clearAllMocks();
    uploadDir = await mkdtemp(join(tmpdir(), 'files-service-'));
    process.env.UPLOAD_DIR = uploadDir;
    prisma.file.update.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FilesService,
        { provide: PrismaService, useValue: prisma },
        { provide: GroqService, useValue: groq },
      ],
    }).compile();

    service = module.get<FilesService>(FilesService);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  /** Puts a real file on disk and the matching row in the mocked database. */
  async function givenStoredFile(
    contents: string,
    overrides: Partial<{
      storedName: string;
      mimeType: string;
      originalName: string;
    }> = {},
  ) {
    const stored = {
      id: 'file-1',
      originalName: 'notes.txt',
      storedName: 'stored-1.txt',
      mimeType: 'text/plain',
      size: contents.length,
      ...overrides,
    };
    await writeFile(join(uploadDir, stored.storedName), contents, 'utf8');
    prisma.file.findUnique.mockResolvedValue(stored);
    return stored;
  }

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('analyze', () => {
    it('saves the extracted conventions and marks the file completed', async () => {
      await givenStoredFile('# Heading\n- a bullet');
      const extraction = minimalExtraction();
      groq.extract.mockResolvedValue(extraction);

      await service.analyze('file-1');

      const completed = updateWithStatus('COMPLETED');
      expect(completed.where).toEqual({ id: 'file-1' });
      expect(completed.data.analysis).toBe(JSON.stringify(extraction));
      expect(completed.data.analyzedAt).toBeInstanceOf(Date);
      expect(completed.data.analysisError).toBeNull();
    });

    it('sends the stored file contents to the model', async () => {
      await givenStoredFile('The actual document text');
      groq.extract.mockResolvedValue(minimalExtraction());

      await service.analyze('file-1');

      expect(groq.extract).toHaveBeenCalledWith(
        'The actual document text',
      );
    });

    it('marks the file processing before calling the model', async () => {
      await givenStoredFile('body');
      let statusWhenModelCalled: string | undefined;
      groq.extract.mockImplementation(() => {
        statusWhenModelCalled = updateWithStatus('PROCESSING').data
          .analysisStatus as string;
        return Promise.resolve(minimalExtraction());
      });

      await service.analyze('file-1');

      expect(statusWhenModelCalled).toBe('PROCESSING');
    });

    it('records the failure when the model call throws', async () => {
      await givenStoredFile('body');
      groq.extract.mockRejectedValue(new Error('Groq is down'));

      await service.analyze('file-1');

      const failed = updateWithStatus('FAILED');
      expect(failed.data.analysisError).toContain('Groq is down');
      expect(failed.data.analysis).toBeUndefined();
    });

    it('does not call the model for a file type it cannot read as text', async () => {
      await givenStoredFile('%PDF-1.4 binary', {
        storedName: 'stored-1.pdf',
        originalName: 'scan.pdf',
        mimeType: 'application/pdf',
      });

      await service.analyze('file-1');

      expect(groq.extract).not.toHaveBeenCalled();
      expect(updateWithStatus('FAILED').data.analysisError).toMatch(
        /unsupported/i,
      );
    });

    it('analyses markdown, which multer reports with a non-text mime type', async () => {
      await givenStoredFile('# Title', {
        storedName: 'stored-1.md',
        originalName: 'readme.md',
        mimeType: 'application/octet-stream',
      });
      groq.extract.mockResolvedValue(minimalExtraction());

      await service.analyze('file-1');

      expect(groq.extract).toHaveBeenCalledWith('# Title');
    });

    it('records the failure when the stored file is missing from disk', async () => {
      prisma.file.findUnique.mockResolvedValue({
        id: 'file-1',
        originalName: 'gone.txt',
        storedName: 'not-on-disk.txt',
        mimeType: 'text/plain',
        size: 10,
      });

      await service.analyze('file-1');

      expect(updateWithStatus('FAILED').data.analysisError).toBeTruthy();
      expect(groq.extract).not.toHaveBeenCalled();
    });

    it('truncates an overlong error message before storing it', async () => {
      await givenStoredFile('body');
      groq.extract.mockRejectedValue(new Error('x'.repeat(2_000)));

      await service.analyze('file-1');

      const stored = updateWithStatus('FAILED').data.analysisError as string;
      expect(stored.length).toBeLessThanOrEqual(500);
    });

    it('does nothing when the file id is unknown', async () => {
      prisma.file.findUnique.mockResolvedValue(null);

      await service.analyze('missing-id');

      expect(groq.extract).not.toHaveBeenCalled();
      expect(prisma.file.update).not.toHaveBeenCalled();
    });

    it('never throws, so a fire-and-forget caller cannot crash the process', async () => {
      await givenStoredFile('body');
      groq.extract.mockRejectedValue(new Error('model exploded'));
      prisma.file.update.mockRejectedValue(new Error('database exploded'));

      await expect(service.analyze('file-1')).resolves.toBeUndefined();
    });
  });

  describe('findOne', () => {
    it('returns the analysis as an object rather than a JSON string', async () => {
      prisma.file.findUnique.mockResolvedValue({
        id: 'file-1',
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        size: 4,
        uploadedAt: new Date(),
        analysis: '{"document_class":{"class":"operative_note"}}',
        analysisStatus: 'COMPLETED',
        analysisError: null,
        analyzedAt: new Date(),
      });

      const result = await service.findOne('file-1');

      expect(result?.analysis).toEqual({
        document_class: { class: 'operative_note' },
      });
    });

    it('returns a null analysis while the file is still pending', async () => {
      prisma.file.findUnique.mockResolvedValue({
        id: 'file-1',
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        size: 4,
        uploadedAt: new Date(),
        analysis: null,
        analysisStatus: 'PENDING',
        analysisError: null,
        analyzedAt: null,
      });

      const result = await service.findOne('file-1');

      expect(result?.analysis).toBeNull();
      expect(result?.analysisStatus).toBe('PENDING');
    });

    it('returns null when no such file exists', async () => {
      prisma.file.findUnique.mockResolvedValue(null);

      await expect(service.findOne('nope')).resolves.toBeNull();
    });
  });

  describe('create', () => {
    it('stores the file metadata', async () => {
      prisma.file.create.mockResolvedValue({ id: 'file-1' });

      await service.create({
        originalName: 'notes.txt',
        storedName: 'stored-1.txt',
        mimeType: 'text/plain',
        size: 12,
      });

      expect(prisma.file.create).toHaveBeenCalledWith({
        data: {
          originalName: 'notes.txt',
          storedName: 'stored-1.txt',
          mimeType: 'text/plain',
          size: 12,
        },
      });
    });
  });
});
