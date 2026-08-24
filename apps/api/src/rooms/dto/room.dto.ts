import { IsEmail, IsEnum, IsOptional, IsString, Length } from 'class-validator';

export class CreateRoomDto {
  @IsString()
  @Length(1, 120)
  name!: string;
}

export class CreateFolderDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  parentId?: string;
}

export class UpdateFolderDto {
  @IsString()
  @Length(1, 120)
  name!: string;
}

export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  @Length(1, 180)
  name?: string;

  @IsOptional()
  folderId?: string | null;
}

export enum ShareScope {
  ROOM = 'ROOM',
  FOLDER = 'FOLDER',
  DOCUMENT = 'DOCUMENT',
}

export enum ShareModeInput {
  PUBLIC = 'PUBLIC',
  PERMISSIONED = 'PERMISSIONED',
}

export class CreateShareDto {
  @IsEnum(ShareScope)
  scope!: ShareScope;

  @IsString()
  targetId!: string;

  @IsEnum(ShareModeInput)
  mode!: ShareModeInput;

  @IsOptional()
  @IsEmail()
  email?: string;
}
