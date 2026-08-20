import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';

/** Used for both email verification and password-reset code checks. */
export class VerifyCodeDto {
  @IsString()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty()
  email: string;

  /** @example "123456" */
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'Invalid code' })
  otp: string;
}
