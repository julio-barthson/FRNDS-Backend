import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
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

  /**
   * Billing order within the list, ascending. Omitted means the array's own
   * order is used, which is what the app sends.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  position?: number;
}

export class TrackInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  /**
   * The recording's ISRC, if it already has one. Format-checked and stored
   * without separators; send an empty string to clear it.
   *
   * Supplied rather than issued: FRNDSHQ has no IFPI registrant code yet, and a
   * recording released elsewhere already carries one — minting a second would
   * split its royalties across two identifiers.
   *
   * @example "GBAYE0000001"
   */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  isrc?: string;

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
  /**
   * Which roster artist this release belongs to. Ignored for a solo artist,
   * who can only ever release as themselves, and required for a label unless
   * its roster holds exactly one artist.
   */
  @IsOptional()
  @IsUUID()
  artistId?: string;

  /**
   * The release barcode, if the artist already holds one. UPC-A, EAN-13 or
   * ITF-14; the check digit is verified. Send an empty string to clear it.
   *
   * @example "036000291452"
   */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  upc?: string;

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

  /**
   * Who the release is billed to — the names shown on the album, in order.
   *
   * Left out on create, the owning artist becomes the sole primary artist,
   * which is the right answer for the great majority of uploads. Sending it
   * replaces that default entirely, so a joint album or a label upload can name
   * whoever it is actually by.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ContributorInputDto)
  contributors?: ContributorInputDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => TrackInputDto)
  tracks: TrackInputDto[];
}
