import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthUser } from '../auth/auth-user';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import {
  CreateFolderDto,
  CreateRoomDto,
  CreateShareDto,
  UpdateDocumentDto,
  UpdateFolderDto,
} from './dto/room.dto';
import { RoomsService } from './rooms.service';

@Controller()
@UseGuards(ClerkAuthGuard)
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get('rooms')
  list(@AuthUser() ownerId: string) {
    return this.rooms.list(ownerId);
  }

  @Post('rooms')
  create(@AuthUser() ownerId: string, @Body() input: CreateRoomDto) {
    return this.rooms.create(ownerId, input.name);
  }

  @Get('rooms/:roomId/contents')
  contents(
    @AuthUser() ownerId: string,
    @Param('roomId') roomId: string,
    @Query('folderId') folderId?: string,
  ) {
    return this.rooms.contents(ownerId, roomId, folderId);
  }

  @Get('rooms/:roomId/folders')
  folderOptions(@AuthUser() ownerId: string, @Param('roomId') roomId: string) {
    return this.rooms.folderOptions(ownerId, roomId);
  }

  @Post('rooms/:roomId/folders')
  createFolder(
    @AuthUser() ownerId: string,
    @Param('roomId') roomId: string,
    @Body() input: CreateFolderDto,
  ) {
    return this.rooms.createFolder(ownerId, roomId, input);
  }

  @Patch('folders/:folderId')
  renameFolder(
    @AuthUser() ownerId: string,
    @Param('folderId') folderId: string,
    @Body() input: UpdateFolderDto,
  ) {
    return this.rooms.renameFolder(ownerId, folderId, input.name);
  }

  @Delete('folders/:folderId')
  deleteFolder(
    @AuthUser() ownerId: string,
    @Param('folderId') folderId: string,
  ) {
    return this.rooms.deleteFolder(ownerId, folderId);
  }

  @Post('rooms/:roomId/documents')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    }),
  )
  async upload(
    @AuthUser() ownerId: string,
    @Param('roomId') roomId: string,
    @Query('folderId') folderId: string | undefined,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const document = await this.rooms.upload(ownerId, roomId, folderId, file);
    return { ...document, size: Number(document.size) };
  }

  @Patch('documents/:documentId')
  async updateDocument(
    @AuthUser() ownerId: string,
    @Param('documentId') documentId: string,
    @Body() input: UpdateDocumentDto,
  ) {
    const document = await this.rooms.updateDocument(
      ownerId,
      documentId,
      input,
    );
    return { ...document, size: Number(document.size) };
  }

  @Delete('documents/:documentId')
  deleteDocument(
    @AuthUser() ownerId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.rooms.deleteDocument(ownerId, documentId);
  }

  @Get('documents/:documentId/content')
  async documentContent(
    @AuthUser() ownerId: string,
    @Param('documentId') documentId: string,
    @Res() response: Response,
  ) {
    const { document, stream } = await this.rooms.documentStream(
      ownerId,
      documentId,
    );
    response.setHeader('Content-Type', document.mimeType);
    response.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(document.name)}`,
    );
    response.setHeader('Content-Length', document.size.toString());
    stream.pipe(response);
  }

  @Post('shares')
  createShare(@AuthUser() ownerId: string, @Body() input: CreateShareDto) {
    return this.rooms.createShare(ownerId, input);
  }

  @Patch('shares/:shareId/revoke')
  revokeShare(@AuthUser() ownerId: string, @Param('shareId') shareId: string) {
    return this.rooms.revokeShare(ownerId, shareId);
  }
}
