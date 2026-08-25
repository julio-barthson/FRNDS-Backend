import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AdminPosition } from '../../generated/prisma/enums';

export class CreateAdminDto {
  @ApiProperty()
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(2, { message: 'First name must be at least 2 characters' })
  @MaxLength(80)
  firstName: string;

  @ApiProperty()
  @IsString()
  @MinLength(2, { message: 'Last name must be at least 2 characters' })
  @MaxLength(80)
  lastName: string;

  @ApiProperty({ enum: AdminPosition })
  @IsEnum(AdminPosition)
  position: AdminPosition;
}

export class UpdateAdminDto {
  @ApiProperty({ enum: AdminPosition })
  @IsOptional()
  @IsEnum(AdminPosition)
  position?: AdminPosition;
}

export class SuspendAdminDto {
  /** Shown to them at sign-in, the same as any other suspended account. */
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}
