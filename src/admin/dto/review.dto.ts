import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ReleaseStatus } from '../../generated/prisma/enums';

/**
 * Which list is being asked for.
 *
 * `queue` is a worklist: only what is waiting on a person, longest wait first.
 * `catalogue` is the archive: every release whatever its status, newest first.
 * They are the same query with different defaults, so they share an endpoint
 * rather than duplicating the mapper and the presigning behind a second one.
 */
export const REVIEW_SCOPES = ['queue', 'catalogue'] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

export class QueueQueryDto {
  @ApiPropertyOptional({
    enum: REVIEW_SCOPES,
    description:
      'Defaults to `queue` — SUBMITTED and IN_REVIEW, oldest submission first. `catalogue` widens to every status, newest first.',
  })
  @IsOptional()
  @IsIn(REVIEW_SCOPES)
  scope?: ReviewScope;

  @ApiPropertyOptional({
    enum: ReleaseStatus,
    description:
      'Narrows to one status. Without it, `queue` means SUBMITTED and IN_REVIEW and `catalogue` means everything.',
  })
  @IsOptional()
  @IsEnum(ReleaseStatus)
  status?: ReleaseStatus;

  /** Matches release title, track title, or the artist's stage name. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class RejectReleaseDto {
  /**
   * Shown to the artist verbatim on the release page, under "What needs
   * fixing". A minimum length because "no" is not a review — the artist has to
   * be able to act on it without asking.
   */
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  notes: string;
}
