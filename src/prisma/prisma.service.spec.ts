import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;
  const originalUrl = process.env.DATABASE_URL;

  beforeAll(() => {
    // The constructor throws without this. Nothing here connects, so a
    // syntactically valid URL is enough — no live database is involved.
    process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/test';
  });

  afterAll(() => {
    process.env.DATABASE_URL = originalUrl;
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
