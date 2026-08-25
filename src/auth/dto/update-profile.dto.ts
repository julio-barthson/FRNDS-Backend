import {
  IsBoolean,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Covers both halves of the profile in one call: the account fields on User
 * and the public artist fields on Artist. Email is intentionally absent —
 * changing it has to re-verify, so it needs its own flow.
 */
export class UpdateProfileDto {
  // ── Account ──────────────────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, {
    message:
      'Phone number must be in international format, e.g. +2348012345678',
  })
  phoneNumber?: string;

  @IsOptional()
  @IsISO31661Alpha2({ message: 'Country must be a two-letter code, e.g. NG' })
  country?: string;

  // ── Artist profile ───────────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  stageName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bio?: string;

  @IsOptional()
  @IsUrl({}, { message: 'Avatar must be a valid URL' })
  avatarUrl?: string;

  /**
   * Set true on the last step of the in-app profile setup. Per-step saves omit
   * it, so a half-finished profile never counts as complete.
   */
  @IsOptional()
  @IsBoolean()
  isComplete?: boolean;

  /**
   * Whether transactional mail reaches them. Silences email only — the in-app
   * notification centre is a record, not a preference, and turning it off would
   * mean an artist could never find out why a release came back.
   */
  @IsOptional()
  @IsBoolean()
  emailNotifications?: boolean;
}
