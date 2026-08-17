import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

const filesService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  analyze: jest.fn(),
};

const uploadedFile = {
  originalname: 'notes.txt',
  filename: 'stored-1.txt',
  mimetype: 'text/plain',
  size: 12,
} as Express.Multer.File;

const request = { headers: {}, body: {} } as Request;

describe('FilesController', () => {
  let controller: FilesController;

  beforeEach(async () => {
    jest.clearAllMocks();
    filesService.analyze.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [{ provide: FilesService, useValue: filesService }],
    }).compile();

    controller = module.get<FilesController>(FilesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('uploadFile', () => {
    it('rejects a request that carries no file part', async () => {
      await expect(controller.uploadFile(undefined, request)).rejects.toThrow(
        BadRequestException,
      );
      expect(filesService.create).not.toHaveBeenCalled();
    });

    it('saves the file metadata and returns the created record', async () => {
      filesService.create.mockResolvedValue({
        id: 'file-1',
        analysisStatus: 'PENDING',
      });

      const result = await controller.uploadFile(uploadedFile, request);

      expect(filesService.create).toHaveBeenCalledWith({
        originalName: 'notes.txt',
        storedName: 'stored-1.txt',
        mimeType: 'text/plain',
        size: 12,
      });
      expect(result).toEqual({ id: 'file-1', analysisStatus: 'PENDING' });
    });

    it('starts the analysis only once the file row has been saved', async () => {
      let savedBeforeAnalysis = false;
      filesService.create.mockResolvedValue({ id: 'file-1' });
      filesService.analyze.mockImplementation((id: string) => {
        savedBeforeAnalysis =
          filesService.create.mock.calls.length === 1 && id === 'file-1';
        return Promise.resolve();
      });

      await controller.uploadFile(uploadedFile, request);

      expect(filesService.analyze).toHaveBeenCalledWith('file-1');
      expect(savedBeforeAnalysis).toBe(true);
    });

    it('responds without waiting for the analysis to finish', async () => {
      filesService.create.mockResolvedValue({ id: 'file-1' });
      filesService.analyze.mockReturnValue(new Promise(() => {})); // never settles

      await expect(
        controller.uploadFile(uploadedFile, request),
      ).resolves.toEqual({ id: 'file-1' });
    });

    it('still returns the upload when kicking off the analysis rejects', async () => {
      filesService.create.mockResolvedValue({ id: 'file-1' });
      filesService.analyze.mockRejectedValue(new Error('unexpected'));

      await expect(
        controller.uploadFile(uploadedFile, request),
      ).resolves.toEqual({ id: 'file-1' });
    });
  });

  describe('findOne', () => {
    it('returns the file with its analysis', async () => {
      const file = { id: 'file-1', analysis: { tone: 'formal' } };
      filesService.findOne.mockResolvedValue(file);

      await expect(controller.findOne('file-1')).resolves.toEqual(file);
    });

    it('raises a 404 when the file does not exist', async () => {
      filesService.findOne.mockResolvedValue(null);

      await expect(controller.findOne('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
