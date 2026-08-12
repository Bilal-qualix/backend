import {
  BadRequestException,
  Controller,
  Logger,
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

export const storage = diskStorage({
  destination: './uploads', 
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

    return this.filesService.create({
      originalName: file.originalname,
      storedName: file.filename, // uuid + extension, set by diskStorage above
      mimeType: file.mimetype,
      size: file.size,
    });
  }

  @Get()
  async findAll() {
    return this.filesService.findAll();
  }
}
