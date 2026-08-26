import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ReleaseStatus } from '../../generated/prisma/enums';

export class QueryReleasesDto {
  @IsOptional()
  @IsEnum(ReleaseStatus)
  status?: ReleaseStatus;

  /**
   * Narrows a label's catalogue to one roster artist. Meaningless for a solo
   * artist, whose scope is already a single id — and safe either way, because
   * the service intersects it with the caller's scope rather than trusting it.
   */
  @IsOptional()
  @IsUUID()
  artistId?: string;

  /** Matches on release or track title. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
