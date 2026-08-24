import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { AuditAction } from '../../generated/prisma/enums';
import type { Prisma } from '../../generated/prisma/client';
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

  async create(ownerId: string, name: string) {
    const room = await this.prisma.dataRoom.create({
      data: { ownerId, name: this.cleanName(name) },
    });
    await this.audit(
      room.id,
      AuditAction.ROOM_CREATED,
      ownerId,
      room.id,
      room.name,
    );
    return room;
  }

  async updateRoom(ownerId: string, roomId: string, requestedName: string) {
    const room = await this.requireRoom(ownerId, roomId);
    const updated = await this.prisma.dataRoom.update({
      where: { id: room.id },
      data: { name: this.cleanName(requestedName) },
    });
    await this.audit(
      room.id,
      AuditAction.ROOM_RENAMED,
      ownerId,
      room.id,
      updated.name,
      { previousName: room.name },
    );
    return updated;
  }

  async deleteRoom(ownerId: string, roomId: string) {
    const room = await this.requireRoom(ownerId, roomId);
    const documents = await this.prisma.document.findMany({
      where: { dataRoomId: room.id },
      select: { storageKey: true },
    });
    await this.storage.remove(documents.map((document) => document.storageKey));
    await this.prisma.dataRoom.delete({ where: { id: room.id } });
    return { deleted: true, deletedDocuments: documents.length };
  }

  async createDemo(ownerId: string) {
    const room = await this.create(ownerId, 'Northstar acquisition');
    const financials = await this.createFolder(ownerId, room.id, {
      name: '01 Financials',
    });
    const legal = await this.createFolder(ownerId, room.id, {
      name: '02 Legal',
    });
    const product = await this.createFolder(ownerId, room.id, {
      name: '03 Product & IP',
    });
    const documents = [
      {
        folderId: financials.id,
        name: 'FY 2025 management accounts.pdf',
        title: 'Management accounts',
        subtitle: 'FY 2025 · Confidential draft',
      },
      {
        folderId: legal.id,
        name: 'Corporate structure.pdf',
        title: 'Corporate structure',
        subtitle: 'Entities, ownership and key agreements',
      },
      {
        folderId: product.id,
        name: 'Product architecture.pdf',
        title: 'Product architecture',
        subtitle: 'Systems, data flows and intellectual property',
      },
    ];
    for (const item of documents) {
      const buffer = await this.demoPdf(item.title, item.subtitle);
      await this.upload(ownerId, room.id, item.folderId, {
        buffer,
        size: buffer.length,
        mimetype: 'application/pdf',
        originalname: item.name,
      } as Express.Multer.File);
    }
    await this.audit(
      room.id,
      AuditAction.DEMO_CREATED,
      ownerId,
      room.id,
      room.name,
    );
    return room;
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

  async overview(ownerId: string, roomId: string) {
    const room = await this.requireRoom(ownerId, roomId);
    const [shares, audit] = await Promise.all([
      this.prisma.share.findMany({
        where: {
          revokedAt: null,
          OR: [
            { dataRoomId: room.id },
            { folder: { dataRoomId: room.id } },
            { document: { dataRoomId: room.id } },
          ],
        },
        include: {
          folder: { select: { name: true } },
          document: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditEvent.findMany({
        where: { dataRoomId: room.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    return {
      room,
      shares: shares.map((share) => ({
        id: share.id,
        token: share.token,
        mode: share.mode,
        role: share.role,
        email: share.email,
        scope: share.dataRoomId
          ? 'ROOM'
          : share.folderId
            ? 'FOLDER'
            : 'DOCUMENT',
        targetName: share.dataRoomId
          ? room.name
          : (share.folder?.name ?? share.document?.name ?? 'Deleted item'),
        createdAt: share.createdAt,
      })),
      audit,
    };
  }

  async createFolder(ownerId: string, roomId: string, input: CreateFolderDto) {
    await this.requireRoom(ownerId, roomId);
    if (input.parentId) await this.requireFolder(roomId, input.parentId);
    const name = await this.availableFolderName(
      roomId,
      input.parentId ?? null,
      this.cleanName(input.name),
    );
    const folder = await this.prisma.folder.create({
      data: {
        dataRoomId: roomId,
        parentId: input.parentId ?? null,
        parentKey: input.parentId ?? ROOT_KEY,
        name,
      },
    });
    await this.audit(
      roomId,
      AuditAction.FOLDER_CREATED,
      ownerId,
      folder.id,
      folder.name,
    );
    return folder;
  }

  async renameFolder(ownerId: string, folderId: string, requestedName: string) {
    const folder = await this.requireOwnedFolder(ownerId, folderId);
    const name = await this.availableFolderName(
      folder.dataRoomId,
      folder.parentId,
      this.cleanName(requestedName),
      folder.id,
    );
    const updated = await this.prisma.folder.update({
      where: { id: folderId },
      data: { name },
    });
    await this.audit(
      folder.dataRoomId,
      AuditAction.FOLDER_RENAMED,
      ownerId,
      folder.id,
      updated.name,
      { previousName: folder.name },
    );
    return updated;
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
    await this.audit(
      folder.dataRoomId,
      AuditAction.FOLDER_DELETED,
      ownerId,
      folder.id,
      folder.name,
      {
        deletedFolders: folderIds.length,
        deletedDocuments: documents.length,
      },
    );
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
      const document = await this.prisma.document.create({
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
      await this.audit(
        roomId,
        AuditAction.DOCUMENT_UPLOADED,
        ownerId,
        document.id,
        document.name,
        { folderId: folderId ?? null },
      );
      return document;
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
    const updated = await this.prisma.document.update({
      where: { id: document.id },
      data: {
        folderId: targetFolderId,
        parentKey: targetFolderId ?? ROOT_KEY,
        name,
      },
    });
    const moved = targetFolderId !== document.folderId;
    await this.audit(
      document.dataRoomId,
      moved ? AuditAction.DOCUMENT_MOVED : AuditAction.DOCUMENT_RENAMED,
      ownerId,
      document.id,
      updated.name,
      {
        previousName: document.name,
        fromFolderId: document.folderId,
        toFolderId: targetFolderId,
      },
    );
    return updated;
  }

  async deleteDocument(ownerId: string, documentId: string) {
    const document = await this.requireOwnedDocument(ownerId, documentId);
    await this.storage.remove([document.storageKey]);
    await this.prisma.document.delete({ where: { id: document.id } });
    await this.audit(
      document.dataRoomId,
      AuditAction.DOCUMENT_DELETED,
      ownerId,
      document.id,
      document.name,
    );
    return { deleted: true };
  }

  async documentStream(ownerId: string, documentId: string) {
    const document = await this.requireOwnedDocument(ownerId, documentId);
    await this.audit(
      document.dataRoomId,
      AuditAction.DOCUMENT_VIEWED,
      ownerId,
      document.id,
      document.name,
    );
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
    const share = await this.prisma.share.create({
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
    const roomId = await this.shareRoomId(share);
    await this.audit(
      roomId,
      AuditAction.SHARE_CREATED,
      ownerId,
      share.id,
      input.scope,
      {
        mode: share.mode,
        email: share.email,
      },
    );
    return share;
  }

  async revokeShare(ownerId: string, shareId: string) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
    if (!share || share.createdBy !== ownerId)
      throw new NotFoundException('Share not found');
    const updated = await this.prisma.share.update({
      where: { id: shareId },
      data: { revokedAt: new Date() },
    });
    await this.audit(
      await this.shareRoomId(share),
      AuditAction.SHARE_REVOKED,
      ownerId,
      share.id,
      share.email ?? share.mode,
    );
    return updated;
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
      await this.audit(
        share.document.dataRoomId,
        AuditAction.SHARE_VIEWED,
        viewer?.userId,
        share.id,
        share.document.name,
      );
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
    await this.audit(
      room.id,
      AuditAction.SHARE_VIEWED,
      viewer?.userId,
      share.id,
      share.folder?.name ?? room.name,
    );
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
    await this.audit(
      document.dataRoomId,
      AuditAction.DOCUMENT_VIEWED,
      viewer?.userId,
      document.id,
      document.name,
      { viaShareId: share.id },
    );
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

  private async shareRoomId(share: {
    dataRoomId: string | null;
    folderId: string | null;
    documentId: string | null;
  }) {
    if (share.dataRoomId) return share.dataRoomId;
    if (share.folderId) {
      const folder = await this.prisma.folder.findUnique({
        where: { id: share.folderId },
        select: { dataRoomId: true },
      });
      if (folder) return folder.dataRoomId;
    }
    if (share.documentId) {
      const document = await this.prisma.document.findUnique({
        where: { id: share.documentId },
        select: { dataRoomId: true },
      });
      if (document) return document.dataRoomId;
    }
    throw new NotFoundException('Shared content no longer exists');
  }

  private audit(
    dataRoomId: string,
    action: AuditAction,
    actorId?: string,
    targetId?: string,
    targetName?: string,
    detail?: Prisma.InputJsonValue,
  ) {
    return this.prisma.auditEvent.create({
      data: {
        dataRoomId,
        action,
        actorId,
        targetId,
        targetName,
        detail,
      },
    });
  }

  private async demoPdf(title: string, subtitle: string) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595, 842]);
    const serif = await pdf.embedFont(StandardFonts.TimesRoman);
    const sans = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 595,
      height: 842,
      color: rgb(0.95, 0.94, 0.9),
    });
    page.drawText('VAULTROOM / NORTHSTAR', {
      x: 54,
      y: 770,
      size: 9,
      font: sans,
      color: rgb(0.27, 0.33, 0.28),
    });
    page.drawText(title, {
      x: 54,
      y: 650,
      size: 34,
      font: serif,
      color: rgb(0.11, 0.13, 0.11),
      maxWidth: 480,
    });
    page.drawText(subtitle, {
      x: 54,
      y: 612,
      size: 12,
      font: sans,
      color: rgb(0.43, 0.46, 0.43),
      maxWidth: 450,
    });
    page.drawLine({
      start: { x: 54, y: 580 },
      end: { x: 541, y: 580 },
      thickness: 1,
      color: rgb(0.72, 0.7, 0.64),
    });
    page.drawText('Prepared for due diligence review', {
      x: 54,
      y: 92,
      size: 10,
      font: sans,
      color: rgb(0.43, 0.46, 0.43),
    });
    return Buffer.from(await pdf.save());
  }
}
