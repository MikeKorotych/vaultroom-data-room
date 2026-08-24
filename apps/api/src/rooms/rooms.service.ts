import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  CreateFolderDto,
  CreateShareDto,
  ShareModeInput,
  ShareScope,
  UpdateDocumentDto,
} from './dto/room.dto';

const ROOT_KEY = 'root';

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  list(ownerId: string) {
    return this.prisma.dataRoom.findMany({
      where: { ownerId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { folders: true, documents: true } } },
    });
  }

  create(ownerId: string, name: string) {
    return this.prisma.dataRoom.create({
      data: { ownerId, name: this.cleanName(name) },
    });
  }

  async contents(ownerId: string, roomId: string, folderId?: string) {
    const room = await this.requireRoom(ownerId, roomId);
    if (folderId) await this.requireFolder(roomId, folderId);
    const [folders, documents, breadcrumbs] = await Promise.all([
      this.prisma.folder.findMany({
        where: { dataRoomId: roomId, parentId: folderId ?? null },
        orderBy: { name: 'asc' },
        include: { _count: { select: { children: true, documents: true } } },
      }),
      this.prisma.document.findMany({
        where: { dataRoomId: roomId, folderId: folderId ?? null },
        orderBy: { name: 'asc' },
      }),
      this.breadcrumbs(roomId, folderId),
    ]);
    return {
      room,
      folderId: folderId ?? null,
      breadcrumbs,
      folders,
      documents: documents.map((document) => ({
        ...document,
        size: Number(document.size),
      })),
    };
  }

  async folderOptions(ownerId: string, roomId: string) {
    await this.requireRoom(ownerId, roomId);
    return this.prisma.folder.findMany({
      where: { dataRoomId: roomId },
      select: { id: true, parentId: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async createFolder(ownerId: string, roomId: string, input: CreateFolderDto) {
    await this.requireRoom(ownerId, roomId);
    if (input.parentId) await this.requireFolder(roomId, input.parentId);
    const name = await this.availableFolderName(
      roomId,
      input.parentId ?? null,
      this.cleanName(input.name),
    );
    return this.prisma.folder.create({
      data: {
        dataRoomId: roomId,
        parentId: input.parentId ?? null,
        parentKey: input.parentId ?? ROOT_KEY,
        name,
      },
    });
  }

  async renameFolder(ownerId: string, folderId: string, requestedName: string) {
    const folder = await this.requireOwnedFolder(ownerId, folderId);
    const name = await this.availableFolderName(
      folder.dataRoomId,
      folder.parentId,
      this.cleanName(requestedName),
      folder.id,
    );
    return this.prisma.folder.update({
      where: { id: folderId },
      data: { name },
    });
  }

  async deleteFolder(ownerId: string, folderId: string) {
    const folder = await this.requireOwnedFolder(ownerId, folderId);
    const folderIds = await this.descendantFolderIds(folder.id);
    const documents = await this.prisma.document.findMany({
      where: { folderId: { in: folderIds } },
      select: { storageKey: true },
    });
    await this.storage.remove(documents.map((document) => document.storageKey));
    await this.prisma.folder.delete({ where: { id: folder.id } });
    return {
      deletedFolders: folderIds.length,
      deletedDocuments: documents.length,
    };
  }

  async upload(
    ownerId: string,
    roomId: string,
    folderId: string | undefined,
    file: Express.Multer.File,
  ) {
    await this.requireRoom(ownerId, roomId);
    if (!file) throw new BadRequestException('Choose a PDF to upload');
    if (file.mimetype !== 'application/pdf')
      throw new BadRequestException('Only PDF files are supported');
    if (folderId) await this.requireFolder(roomId, folderId);
    const name = await this.availableDocumentName(
      roomId,
      folderId ?? null,
      this.cleanName(file.originalname),
    );
    const storageKey = `${ownerId}/${roomId}/${randomUUID()}.pdf`;
    await this.storage.put(storageKey, file.buffer, file.mimetype);
    try {
      return await this.prisma.document.create({
        data: {
          dataRoomId: roomId,
          folderId: folderId ?? null,
          parentKey: folderId ?? ROOT_KEY,
          name,
          mimeType: file.mimetype,
          size: BigInt(file.size),
          storageKey,
        },
      });
    } catch (error) {
      await this.storage.remove([storageKey]);
      throw error;
    }
  }

  async updateDocument(
    ownerId: string,
    documentId: string,
    input: UpdateDocumentDto,
  ) {
    const document = await this.requireOwnedDocument(ownerId, documentId);
    const targetFolderId =
      input.folderId === undefined ? document.folderId : input.folderId;
    if (targetFolderId)
      await this.requireFolder(document.dataRoomId, targetFolderId);
    const requestedName = this.cleanName(input.name ?? document.name);
    const name = await this.availableDocumentName(
      document.dataRoomId,
      targetFolderId,
      requestedName,
      document.id,
    );
    return this.prisma.document.update({
      where: { id: document.id },
      data: {
        folderId: targetFolderId,
        parentKey: targetFolderId ?? ROOT_KEY,
        name,
      },
    });
  }

  async deleteDocument(ownerId: string, documentId: string) {
    const document = await this.requireOwnedDocument(ownerId, documentId);
    await this.storage.remove([document.storageKey]);
    await this.prisma.document.delete({ where: { id: document.id } });
    return { deleted: true };
  }

  async documentStream(ownerId: string, documentId: string) {
    const document = await this.requireOwnedDocument(ownerId, documentId);
    return { document, stream: await this.storage.get(document.storageKey) };
  }

  async createShare(ownerId: string, input: CreateShareDto) {
    if (input.mode === ShareModeInput.PERMISSIONED && !input.email) {
      throw new BadRequestException(
        'Email is required for a permissioned share',
      );
    }
    const target = await this.resolveOwnedShareTarget(
      ownerId,
      input.scope,
      input.targetId,
    );
    return this.prisma.share.create({
      data: {
        ...target,
        mode: input.mode,
        role: 'VIEWER',
        token: randomBytes(24).toString('base64url'),
        email:
          input.mode === ShareModeInput.PERMISSIONED
            ? input.email?.toLowerCase()
            : null,
        createdBy: ownerId,
      },
    });
  }

  async revokeShare(ownerId: string, shareId: string) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
    if (!share || share.createdBy !== ownerId)
      throw new NotFoundException('Share not found');
    return this.prisma.share.update({
      where: { id: shareId },
      data: { revokedAt: new Date() },
    });
  }

  async sharedView(
    token: string,
    viewer?: { userId: string; emails: string[] },
    requestedFolderId?: string,
  ) {
    const share = await this.prisma.share.findUnique({
      where: { token },
      include: {
        dataRoom: true,
        folder: { include: { dataRoom: true } },
        document: true,
      },
    });
    if (!share || share.revokedAt)
      throw new NotFoundException('Share link is unavailable');
    if (share.mode === 'PERMISSIONED') {
      const allowed =
        viewer &&
        (viewer.userId === share.createdBy ||
          viewer.emails.includes(share.email ?? ''));
      if (!allowed)
        throw new ForbiddenException('Sign in with the invited email address');
    }
    if (share.document) {
      return {
        share: {
          mode: share.mode,
          scope: 'DOCUMENT',
          createdAt: share.createdAt,
        },
        room: await this.prisma.dataRoom.findUnique({
          where: { id: share.document.dataRoomId },
          select: { name: true },
        }),
        document: this.publicDocument(share.document),
      };
    }
    const room = share.dataRoom ?? share.folder?.dataRoom;
    if (!room) throw new NotFoundException('Shared content no longer exists');
    const folderId = requestedFolderId ?? share.folderId ?? undefined;
    if (folderId) {
      const requestedFolder = await this.requireFolder(room.id, folderId);
      if (share.folderId) {
        const descendants = await this.descendantFolderIds(share.folderId);
        if (!descendants.includes(requestedFolder.id)) {
          throw new ForbiddenException('Folder is outside this share');
        }
      }
    }
    const [folders, documents, breadcrumbs] = await Promise.all([
      this.prisma.folder.findMany({
        where: { dataRoomId: room.id, parentId: folderId ?? null },
        orderBy: { name: 'asc' },
        include: { _count: { select: { children: true, documents: true } } },
      }),
      this.prisma.document.findMany({
        where: { dataRoomId: room.id, folderId: folderId ?? null },
        orderBy: { name: 'asc' },
      }),
      this.breadcrumbs(room.id, folderId),
    ]);
    return {
      share: {
        mode: share.mode,
        scope: share.folderId ? 'FOLDER' : 'ROOM',
        createdAt: share.createdAt,
      },
      room: { id: room.id, name: room.name },
      folderId: folderId ?? null,
      breadcrumbs: share.folderId
        ? breadcrumbs.slice(
            Math.max(
              0,
              breadcrumbs.findIndex((item) => item.id === share.folderId),
            ),
          )
        : breadcrumbs,
      folders,
      documents: documents.map((document) => this.publicDocument(document)),
    };
  }

  async sharedDocumentStream(
    token: string,
    documentId: string,
    viewer?: { userId: string; emails: string[] },
  ) {
    const share = await this.prisma.share.findUnique({ where: { token } });
    if (!share || share.revokedAt)
      throw new NotFoundException('Share link is unavailable');
    if (share.mode === 'PERMISSIONED') {
      const allowed =
        viewer &&
        (viewer.userId === share.createdBy ||
          viewer.emails.includes(share.email ?? ''));
      if (!allowed)
        throw new ForbiddenException('Sign in with the invited email address');
    }
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
    });
    if (!document) throw new NotFoundException('Document not found');
    let allowed =
      share.documentId === document.id ||
      share.dataRoomId === document.dataRoomId;
    if (!allowed && share.folderId) {
      const descendants = await this.descendantFolderIds(share.folderId);
      allowed = !!document.folderId && descendants.includes(document.folderId);
    }
    if (!allowed)
      throw new ForbiddenException('Document is outside this share');
    return { document, stream: await this.storage.get(document.storageKey) };
  }

  private async requireRoom(ownerId: string, roomId: string) {
    const room = await this.prisma.dataRoom.findFirst({
      where: { id: roomId, ownerId },
    });
    if (!room) throw new NotFoundException('Data room not found');
    return room;
  }

  private async requireFolder(roomId: string, folderId: string) {
    const folder = await this.prisma.folder.findFirst({
      where: { id: folderId, dataRoomId: roomId },
    });
    if (!folder) throw new NotFoundException('Folder not found');
    return folder;
  }

  private async requireOwnedFolder(ownerId: string, folderId: string) {
    const folder = await this.prisma.folder.findFirst({
      where: { id: folderId, dataRoom: { ownerId } },
    });
    if (!folder) throw new NotFoundException('Folder not found');
    return folder;
  }

  private async requireOwnedDocument(ownerId: string, documentId: string) {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, dataRoom: { ownerId } },
    });
    if (!document) throw new NotFoundException('Document not found');
    return document;
  }

  private cleanName(name: string) {
    const clean = name.trim().replace(/[\\/:*?"<>|]/g, '-');
    if (!clean) throw new BadRequestException('Name cannot be empty');
    return clean.slice(0, 180);
  }

  private async availableFolderName(
    roomId: string,
    parentId: string | null,
    requested: string,
    ignoreId?: string,
  ) {
    let candidate = requested;
    for (let suffix = 1; suffix < 1000; suffix += 1) {
      const existing = await this.prisma.folder.findFirst({
        where: {
          dataRoomId: roomId,
          parentId,
          name: candidate,
          id: ignoreId ? { not: ignoreId } : undefined,
        },
      });
      if (!existing) return candidate;
      candidate = `${requested} (${suffix})`;
    }
    throw new ConflictException('Could not resolve folder name conflict');
  }

  private async availableDocumentName(
    roomId: string,
    folderId: string | null,
    requested: string,
    ignoreId?: string,
  ) {
    const dot = requested.lastIndexOf('.');
    const base = dot > 0 ? requested.slice(0, dot) : requested;
    const extension = dot > 0 ? requested.slice(dot) : '';
    let candidate = requested;
    for (let suffix = 1; suffix < 1000; suffix += 1) {
      const existing = await this.prisma.document.findFirst({
        where: {
          dataRoomId: roomId,
          folderId,
          name: candidate,
          id: ignoreId ? { not: ignoreId } : undefined,
        },
      });
      if (!existing) return candidate;
      candidate = `${base} (${suffix})${extension}`;
    }
    throw new ConflictException('Could not resolve document name conflict');
  }

  private async breadcrumbs(roomId: string, folderId?: string) {
    const chain: Array<{ id: string; name: string }> = [];
    let currentId = folderId;
    while (currentId) {
      const folder = await this.requireFolder(roomId, currentId);
      chain.unshift({ id: folder.id, name: folder.name });
      currentId = folder.parentId ?? undefined;
    }
    return chain;
  }

  private async descendantFolderIds(rootId: string) {
    const result = [rootId];
    let frontier = [rootId];
    while (frontier.length) {
      const children = await this.prisma.folder.findMany({
        where: { parentId: { in: frontier } },
        select: { id: true },
      });
      frontier = children.map((folder) => folder.id);
      result.push(...frontier);
    }
    return result;
  }

  private async resolveOwnedShareTarget(
    ownerId: string,
    scope: ShareScope,
    targetId: string,
  ) {
    if (scope === ShareScope.ROOM) {
      await this.requireRoom(ownerId, targetId);
      return { dataRoomId: targetId };
    }
    if (scope === ShareScope.FOLDER) {
      await this.requireOwnedFolder(ownerId, targetId);
      return { folderId: targetId };
    }
    await this.requireOwnedDocument(ownerId, targetId);
    return { documentId: targetId };
  }

  private publicDocument(document: {
    id: string;
    folderId: string | null;
    name: string;
    mimeType: string;
    size: bigint;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: document.id,
      folderId: document.folderId,
      name: document.name,
      mimeType: document.mimeType,
      size: Number(document.size),
      version: document.version,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }
}
