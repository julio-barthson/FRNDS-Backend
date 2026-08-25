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
import { AccountStatus } from '../../generated/prisma/enums';

/** The account roles this page covers. ADMIN is not one of them. */
export const ACCOUNT_ROLES = ['ARTIST', 'LABEL'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export class AccountsQueryDto {
  /** Matches email, first or last name, stage name, or label name. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: ACCOUNT_ROLES })
  @IsOptional()
  @IsIn(ACCOUNT_ROLES)
  role?: AccountRole;

  @ApiPropertyOptional({ enum: AccountStatus })
  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

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

export class SuspendAccountDto {
  /**
   * Shown to the account holder when they are refused at sign-in, so it has to
   * say something they can act on. A minimum length for the same reason a
   * rejection note has one.
   */
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}
