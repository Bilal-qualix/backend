import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface CreateFileMeta {
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
}

@Injectable()
export class FilesService {
  constructor(private prisma: PrismaService) {}

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
        // deliberately NOT returning storedName — the client doesn't need
        // the uuid filename on disk
      },
    });
  }
}
