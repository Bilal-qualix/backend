import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { GroqService } from '../ai/groq.service';
import { DocumentExtraction } from '../ai/schema';
import { isAnalysableAsText, uploadDir } from './upload.constants';

interface CreateFileMeta {
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
}

/** Postgres would accept more, but there's nothing useful past the first line. */
const MAX_ERROR_CHARS = 500;

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private prisma: PrismaService,
    private groq: GroqService,
  ) {}

  create(data: CreateFileMeta) {
    return this.prisma.file.create({ data });
  }

  findAll() {
    return this.prisma.file.findMany({
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        originalName: true,
        uploadedAt: true,
        mimeType: true,
        size: true,
        analysisStatus: true,
        analyzedAt: true,
        // deliberately NOT returning storedName — the client doesn't need
        // the uuid filename on disk
      },
    });
  }

  async findOne(id: string) {
    const file = await this.prisma.file.findUnique({
      where: { id },
      select: {
        id: true,
        originalName: true,
        uploadedAt: true,
        mimeType: true,
        size: true,
        analysis: true,
        analysisStatus: true,
        analysisError: true,
        analyzedAt: true,
      },
    });

    if (!file) return null;

    return { ...file, analysis: this.deserialiseAnalysis(file.analysis) };
  }

  /**
   * Analyses an already-stored file and writes the result back to its row.
   *
   * Runs after the upload response has been sent, so it reports every outcome
   * through analysisStatus/analysisError rather than by throwing — a rejected
   * promise here would have no caller left to catch it.
   */
  async analyze(id: string): Promise<void> {
    try {
      const file = await this.prisma.file.findUnique({ where: { id } });
      if (!file) {
        this.logger.warn(`Analysis skipped: no file with id ${id}`);
        return;
      }

      if (!isAnalysableAsText(file.mimeType, file.originalName)) {
        throw new Error(
          `Unsupported file type for analysis: ${file.mimeType}. Only text documents are analysed.`,
        );
      }

      await this.prisma.file.update({
        where: { id },
        data: { analysisStatus: 'PROCESSING' },
      });

      const text = await readFile(join(uploadDir(), file.storedName), 'utf8');
      const extraction = await this.groq.extract(text);

      await this.prisma.file.update({
        where: { id },
        data: {
          analysis: JSON.stringify(extraction),
          analysisStatus: 'COMPLETED',
          analysisError: null,
          analyzedAt: new Date(),
        },
      });
      this.logger.log(`Analysis completed for file ${id}`);
    } catch (error) {
      await this.markFailed(id, error);
    }
  }

  private async markFailed(id: string, error: unknown): Promise<void> {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, MAX_ERROR_CHARS);

    this.logger.error(`Analysis failed for file ${id}: ${message}`);

    try {
      await this.prisma.file.update({
        where: { id },
        data: {
          analysisStatus: 'FAILED',
          analysisError: message,
          analyzedAt: new Date(),
        },
      });
    } catch (updateError) {
      // The database is the only place left to report this, and it just refused.
      this.logger.error(
        `Could not record the analysis failure for file ${id}: ${
          updateError instanceof Error
            ? updateError.message
            : String(updateError)
        }`,
      );
    }
  }

  /** Stored as a JSON string; handed to clients as an object. */
  private deserialiseAnalysis(
    analysis: string | null,
  ): DocumentExtraction | null {
    if (!analysis) return null;
    try {
      return JSON.parse(analysis) as DocumentExtraction;
    } catch {
      this.logger.warn('Stored analysis was not parseable JSON');
      return null;
    }
  }
}
