import { BadRequestException, NotFoundException } from '@nestjs/common';

jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));
jest.mock('../storage/storage.service', () => ({
  StorageService: class StorageService {},
}));

import { RoomsService } from './rooms.service';
import { ShareModeInput, ShareScope } from './dto/room.dto';

describe('RoomsService', () => {
  const prisma = {
    dataRoom: { create: jest.fn(), findFirst: jest.fn() },
    folder: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    document: { findMany: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
    share: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  };
  const storage = { put: jest.fn(), get: jest.fn(), remove: jest.fn() };
  const service = new RoomsService(prisma as never, storage as never);

  beforeEach(() => jest.clearAllMocks());

  it('sanitises names before creating a room', async () => {
    prisma.dataRoom.create.mockResolvedValue({ id: 'room-1', name: 'Deal-Q3' });
    await service.create('owner-1', '  Deal/Q3  ');
    expect(prisma.dataRoom.create).toHaveBeenCalledWith({
      data: { ownerId: 'owner-1', name: 'Deal-Q3' },
    });
  });

  it('rejects non-PDF uploads before writing to object storage', async () => {
    prisma.dataRoom.findFirst.mockResolvedValue({
      id: 'room-1',
      ownerId: 'owner-1',
    });
    await expect(
      service.upload('owner-1', 'room-1', undefined, {
        mimetype: 'image/png',
        originalname: 'scan.png',
      } as Express.Multer.File),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('requires an email for permissioned shares', async () => {
    await expect(
      service.createShare('owner-1', {
        scope: ShareScope.ROOM,
        targetId: 'room-1',
        mode: ShareModeInput.PERMISSIONED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.share.create).not.toHaveBeenCalled();
  });

  it('deletes nested folder documents from storage before the database cascade', async () => {
    prisma.folder.findFirst.mockResolvedValue({
      id: 'folder-1',
      dataRoomId: 'room-1',
    });
    prisma.folder.findMany
      .mockResolvedValueOnce([{ id: 'folder-2' }])
      .mockResolvedValueOnce([]);
    prisma.document.findMany.mockResolvedValue([
      { storageKey: 'room/file-a.pdf' },
    ]);
    storage.remove.mockResolvedValue(undefined);
    prisma.folder.delete.mockResolvedValue({ id: 'folder-1' });

    await expect(service.deleteFolder('owner-1', 'folder-1')).resolves.toEqual({
      deletedFolders: 2,
      deletedDocuments: 1,
    });
    expect(storage.remove).toHaveBeenCalledWith(['room/file-a.pdf']);
    expect(prisma.folder.delete).toHaveBeenCalledWith({
      where: { id: 'folder-1' },
    });
  });

  it('does not allow another owner to revoke a share', async () => {
    prisma.share.findUnique.mockResolvedValue({
      id: 'share-1',
      createdBy: 'owner-2',
    });
    await expect(
      service.revokeShare('owner-1', 'share-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.share.update).not.toHaveBeenCalled();
  });
});
