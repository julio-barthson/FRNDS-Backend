import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Apple requires account deletion to be reachable from inside the app, so this
 * is a first-class endpoint rather than a support request.
 */
export class DeleteAccountDto {
  /**
   * Required for password accounts — deletion is irreversible, so it must not
   * be possible with a stolen access token alone.
   */
  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
