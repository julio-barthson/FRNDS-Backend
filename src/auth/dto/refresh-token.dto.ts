import { IsOptional, IsString } from 'class-validator';

/**
 * Mobile clients send the refresh token in the body. A future web dashboard
 * can rely on the httpOnly cookie instead, which is why this is optional.
 */
export class RefreshTokenDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
