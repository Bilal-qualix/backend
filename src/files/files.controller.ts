import {
  BadRequestException,
  Controller,
  Logger,
  NotFoundException,
  Param,
  Post,
  Get,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { FilesService } from './files.service';
import { uploadDir } from './upload.constants';

export const storage = diskStorage({
  destination: uploadDir(),
  filename: (req, file, callback) => {
    const uniqueId = uuidv4();
    const ext = extname(file.originalname); // e.g. ".pdf"
    callback(null, `${uniqueId}${ext}`);
  },
});

@Controller('files')
export class FilesController {
  private readonly logger = new Logger(FilesController.name);

  constructor(private readonly filesService: FilesService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { storage }))
  async uploadFile(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    // Multer leaves this undefined when the request carries no file part on the
    // "file" field — e.g. a JSON body, or multipart with a Content-Type header set
    // by hand (which drops the boundary). Without this guard that's an opaque 500.
    if (!file) {
      const contentType = req.headers['content-type'] ?? '(none)';
      const textFields = Object.keys(req.body ?? {});
      this.logger.warn(
        `Upload rejected: no file part. content-type="${contentType}" ` +
          `hasBoundary=${String(contentType).includes('boundary=')} ` +
          `nonFileFields=[${textFields.join(', ')}]`,
      );
      throw new BadRequestException(
        'No file uploaded. Send multipart/form-data with a file part named "file".',
      );
    }

    // The file is already on disk by the time we get here (multer wrote it),
    // so this row is the durable record of it before anything else happens.
    const saved = await this.filesService.create({
      originalName: file.originalname,
      storedName: file.filename, // uuid + extension, set by diskStorage above
      mimeType: file.mimetype,
      size: file.size,
    });

    // Deliberately not awaited: the client gets its response now, and the
    // analysis result lands on the row later. analyze() reports its own
    // failures via analysisStatus; the catch is a backstop so an unexpected
    // throw can never become an unhandled rejection.
    void this.filesService.analyze(saved.id).catch((error) => {
      this.logger.error(
        `Background analysis for file ${saved.id} threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    return saved;
  }

  @Get()
  async findAll() {
    return this.filesService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const file = await this.filesService.findOne(id);
    if (!file) {
      throw new NotFoundException(`No file with id ${id}`);
    }
    return file;
  }
}
