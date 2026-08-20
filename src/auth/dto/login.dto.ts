import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  /** @example "artist@example.com" */
  @IsString()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty()
  email: string;

  // Deliberately no length or complexity rules here. Login must accept
  // whatever is already stored; rejecting a short legacy password at the DTO
  // layer would lock the account out with a validation error instead of a
  // clean "invalid credentials".
  @IsString()
  @IsNotEmpty()
  password: string;
}
