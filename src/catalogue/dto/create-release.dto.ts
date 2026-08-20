import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ContributorRole, ReleaseType } from '../../generated/prisma/enums';

export class ContributorInputDto {
  /** @example "Sarz" */
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name: string;

  @IsEnum(ContributorRole)
  role: ContributorRole;

  /** Free text when role is OTHER, e.g. "Backing vocals". */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  roleNote?: string;
}

export class TrackInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  /** @example "Radio Edit" */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  versionTitle?: string;

  @IsOptional()
  @IsBoolean()
  explicit?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  lyrics?: string;

  /**
   * A confirmed AUDIO upload from `POST /media/upload-url`. Can be attached
   * later with `PATCH /releases/{id}/tracks/{trackId}` — a draft is allowed to
   * exist before the file finishes uploading.
   */
  @IsOptional()
  @IsUUID()
  audioAssetId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ContributorInputDto)
  contributors?: ContributorInputDto[];
}

export class CreateReleaseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  /** Defaults to SINGLE, which must carry exactly one track. */
  @IsOptional()
  @IsEnum(ReleaseType)
  type?: ReleaseType;

  /** ISO date. The intended street date, not the upload date. */
  @IsOptional()
  @IsDateString()
  releaseDate?: string;

  /** @example "en" */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  primaryGenre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  secondaryGenre?: string;

  /** Composition copyright line, e.g. "2026 FRNDSHQ". */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cLine?: string;

  /** Recording copyright line. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  pLine?: string;

  /** A confirmed ARTWORK upload. Required before the release can be submitted. */
  @IsOptional()
  @IsUUID()
  artworkAssetId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => TrackInputDto)
  tracks: TrackInputDto[];
}
