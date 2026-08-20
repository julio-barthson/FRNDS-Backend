import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request as ExpressRequest, Response } from 'express';
import { AuthService } from './auth.service';
import { TokenService, type DeviceMeta } from './token.service';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { Public } from '../decorators/public.decorator';
import { CurrentUser } from '../decorators/current-user.decorator';
import { AccountTypeDto } from './dto/account-type.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterUserDto } from './dto/register-user.dto';
import { SetNewPasswordDto } from './dto/set-new-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── Registration & verification ───────────────────────────────────────────

  @Public()
  @ApiOperation({
    summary: 'Create an artist account',
    description:
      'Creates the user and their artist profile, then emails a 6-digit verification code. No tokens are returned until the email is verified.',
  })
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterUserDto) {
    return this.authService.register(dto);
  }

  @Public()
  @ApiOperation({
    summary: 'Verify email and sign in',
    description:
      'Confirms the code from the signup email and returns a token pair. Store `refreshToken` in secure storage (expo-secure-store), not AsyncStorage.',
  })
  @Throttle({ default: { ttl: 600_000, limit: 10 } })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(
    @Body() dto: VerifyCodeDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.authService.verifyEmailOTP(
      dto.email,
      dto.otp,
      deviceFrom(req),
    );
    setAuthCookies(res, session.accessToken, session.refreshToken);
    return session;
  }

  @Public()
  @ApiOperation({ summary: 'Resend the email verification code' })
  @ApiBody({ type: ForgotPasswordDto })
  @Throttle({ default: { ttl: 600_000, limit: 3 } })
  @Post('resend-email-verification')
  @HttpCode(HttpStatus.OK)
  resendEmailVerification(@Body() dto: ForgotPasswordDto) {
    return this.authService.sendEmailVerificationOTP(dto.email);
  }

  // ── Session ───────────────────────────────────────────────────────────────

  @Public()
  @ApiOperation({
    summary: 'Sign in with email and password',
    description:
      'Returns `accessToken` (15 min) and `refreshToken` (30 days). Send `Authorization: Bearer <accessToken>` on subsequent requests.',
  })
  @ApiBody({ type: LoginDto })
  @Throttle({ default: { ttl: 900_000, limit: 5 } })
  @UseGuards(LocalAuthGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Req() req: ExpressRequest & { user: { id: string } },
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.authService.login(req.user, deviceFrom(req));
    setAuthCookies(res, session.accessToken, session.refreshToken);
    return session;
  }

  @Public()
  @ApiOperation({
    summary: 'Sign in with Google',
    description:
      'Takes the `id_token` the app received from Google and returns the same session shape as `/auth/login`. Creates the account and its artist profile on first use; no email verification step, since Google has already proven the address.',
  })
  @Throttle({ default: { ttl: 900_000, limit: 10 } })
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async google(
    @Body() dto: GoogleAuthDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.authService.loginWithGoogle(
      dto.idToken,
      deviceFrom(req),
    );
    setAuthCookies(res, session.accessToken, session.refreshToken);
    return session;
  }

  @Public()
  @ApiOperation({
    summary: 'Rotate the token pair',
    description:
      'The old refresh token is invalidated immediately — always store the new one. Reusing a rotated token revokes that device.',
  })
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = dto.refreshToken ?? refreshCookie(req);

    if (!refreshToken) {
      res.status(HttpStatus.UNAUTHORIZED);
      return { message: 'No refresh token provided' };
    }

    const result = await this.authService.refresh(
      refreshToken,
      deviceFrom(req),
    );

    if (!result) {
      clearAuthCookies(res);
      res.status(HttpStatus.UNAUTHORIZED);
      return { message: 'Session expired. Please sign in again.' };
    }

    setAuthCookies(res, result.accessToken, result.refreshToken);
    return result;
  }

  @Public()
  @ApiOperation({
    summary: 'Sign out of this device',
    description: 'Revokes only the session the refresh token belongs to.',
  })
  @ApiBody({ type: RefreshTokenDto, required: false })
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = dto?.refreshToken ?? refreshCookie(req);
    clearAuthCookies(res);
    return this.authService.logout(refreshToken);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out of every device' })
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  logoutAll(@CurrentUser('sub') userId: string) {
    return this.authService.logoutAll(userId);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active sessions (devices)' })
  @Get('sessions')
  sessions(@CurrentUser('sub') userId: string) {
    return this.authService.listSessions(userId);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one session by id' })
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  async revokeSession(
    @CurrentUser('sub') userId: string,
    @Param('id') sessionId: string,
  ) {
    await this.authService.revokeSession(userId, sessionId);
    return { message: 'Session revoked' };
  }

  // ── Password ──────────────────────────────────────────────────────────────

  @Public()
  @ApiOperation({ summary: 'Send a password reset code' })
  @Throttle({ default: { ttl: 600_000, limit: 3 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.sendPasswordResetOTP(dto.email);
  }

  @Public()
  @ApiOperation({
    summary: 'Check a password reset code',
    description:
      'Optional step so the app can advance screens before asking for the new password. The code is not consumed.',
  })
  @Throttle({ default: { ttl: 600_000, limit: 5 } })
  @Post('verify-code')
  @HttpCode(HttpStatus.OK)
  verifyCode(@Body() dto: VerifyCodeDto) {
    return this.authService.verifyResetCode(dto.email, dto.otp);
  }

  @Public()
  @ApiOperation({
    summary: 'Set a new password using a reset code',
    description: 'Signs out every device on success.',
  })
  @Throttle({ default: { ttl: 600_000, limit: 5 } })
  @Post('set-new-password')
  @HttpCode(HttpStatus.OK)
  setNewPassword(@Body() dto: SetNewPasswordDto) {
    return this.authService.setNewPassword(dto);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change password while signed in',
    description: 'Signs out every device on success, including this one.',
  })
  @Patch('change-password')
  @HttpCode(HttpStatus.OK)
  changePassword(
    @CurrentUser('sub') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      userId,
      dto.currentPassword,
      dto.newPassword,
      dto.confirmPassword,
    );
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the signed-in user and artist profile' })
  @Get('me')
  getMe(@CurrentUser('sub') userId: string) {
    return this.authService.findUserById(userId);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Choose artist or label, creating the profile',
    description:
      'The first onboarding step. Creates the artist or label row behind the login and sets the role. Re-callable until onboarding is finished, so a wrong choice can be corrected.',
  })
  @Post('account-type')
  @HttpCode(HttpStatus.OK)
  setAccountType(
    @CurrentUser('sub') userId: string,
    @Body() dto: AccountTypeDto,
  ) {
    return this.authService.setAccountType(userId, dto);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update account and artist profile',
    description:
      'Send `isComplete: true` on the final onboarding step to mark the profile finished.',
  })
  @Patch('profile')
  updateProfile(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(userId, dto);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete this account',
    description:
      'Required by App Store guideline 5.1.1(v). Anonymises the account, revokes every session, and schedules uploads for removal.',
  })
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @Delete('me')
  @HttpCode(HttpStatus.OK)
  async deleteAccount(
    @CurrentUser('sub') userId: string,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.deleteAccount(
      userId,
      dto?.password,
      dto?.reason,
    );
    clearAuthCookies(res);
    return result;
  }
}

// ── Request helpers ─────────────────────────────────────────────────────────

/** `req.cookies` is untyped on Express; narrow it once here. */
function refreshCookie(req: ExpressRequest): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.refreshToken;
}

/**
 * Session metadata for the device list. The custom headers are set by the
 * mobile app; the user-agent fallback covers browsers and API tools.
 */
function deviceFrom(req: ExpressRequest): DeviceMeta {
  const header = (name: string) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  return {
    deviceName: header('x-device-name')?.slice(0, 100),
    platform: header('x-platform')?.slice(0, 20),
    appVersion: header('x-app-version')?.slice(0, 20),
    ipAddress: req.ip,
    userAgent: header('user-agent')?.slice(0, 255),
  };
}

/**
 * Cookies exist for a future web dashboard. The mobile app ignores them and
 * uses the tokens in the response body.
 */
function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ('none' as const) : ('lax' as const),
    path: '/',
  };
}

function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
) {
  const options = cookieOptions();
  const maxAge = TokenService.refreshTokenTtlMs;
  res.cookie('accessToken', accessToken, { ...options, maxAge });
  res.cookie('refreshToken', refreshToken, { ...options, maxAge });
}

function clearAuthCookies(res: Response) {
  const options = cookieOptions();
  res.clearCookie('accessToken', options);
  res.clearCookie('refreshToken', options);
}
