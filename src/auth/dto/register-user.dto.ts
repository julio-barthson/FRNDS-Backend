import {
  Equals,
  IsBoolean,
  IsEmail,
  IsISO31661Alpha2,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Signup collects the login and the contact details only. The display name —
 * a stage name or an imprint — is asked for on the first onboarding step,
 * where the account type is finally known.
 */
export class RegisterUserDto {
  /** @example "artist@example.com" */
  @IsString()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty()
  email: string;

  /**
   * E.164 format, including the country code. Artists span multiple countries,
   * so a local-format number cannot be interpreted reliably.
   * @example "+2348012345678"
   */
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, {
    message:
      'Phone number must be in international format, e.g. +2348012345678',
  })
  phoneNumber: string;

  /**
   * Two-letter ISO country code.
   * @example "NG"
   */
  @IsString()
  @IsISO31661Alpha2({ message: 'Country must be a two-letter code, e.g. NG' })
  country: string;

  /**
   * Minimum 8 characters with at least one letter and one number. Capped at 72
   * because bcrypt silently ignores anything past 72 bytes.
   */
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(72, { message: 'Password must not exceed 72 characters' })
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, {
    message: 'Password must contain at least one letter and one number',
  })
  password: string;

  @IsString()
  @IsNotEmpty()
  confirmPassword: string;

  /**
   * Must be true. Artists upload master recordings, so the account cannot exist
   * without a recorded agreement to the terms.
   */
  @IsBoolean()
  @Equals(true, { message: 'You must accept the terms of service' })
  acceptTerms: boolean;
}
