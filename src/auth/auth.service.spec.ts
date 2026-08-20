import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterUserDto } from './dto/register-user.dto';

const baseDto: RegisterUserDto = {
  email: 'artist@example.com',
  phoneNumber: '+2348012345678',
  country: 'NG',
  password: 'password1',
  confirmPassword: 'password1',
  acceptTerms: true,
};

interface CreatedUserData {
  email: string;
  password: string;
  acceptedTermsAt: Date;
  artist?: unknown;
  role?: unknown;
}

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; create: jest.Mock };
    artist: { findUnique: jest.Mock };
  };
  let mail: { sendMail: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), create: jest.fn() },
      artist: { findUnique: jest.fn() },
    };
    mail = { sendMail: jest.fn().mockResolvedValue({ delivered: true }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
        { provide: TokenService, useValue: {} },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('rejects mismatched passwords before touching the database', async () => {
    await expect(
      service.register({ ...baseDto, confirmPassword: 'different1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an email that already has an account', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'existing' });

    await expect(service.register(baseDto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('creates the login and emails a code', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ email: baseDto.email });

    await service.register(baseDto);

    const data = (
      prisma.user.create.mock.calls[0] as [{ data: CreatedUserData }]
    )[0].data;
    expect(data.email).toBe('artist@example.com');
    expect(data.password).not.toBe(baseDto.password); // hashed
    expect(data.acceptedTermsAt).toBeInstanceOf(Date);
    expect(mail.sendMail).toHaveBeenCalled();
  });

  it('creates no profile row — the account type is chosen in onboarding', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ email: baseDto.email });

    await service.register(baseDto);

    const data = (
      prisma.user.create.mock.calls[0] as [{ data: CreatedUserData }]
    )[0].data;
    // Signup cannot know whether this is an artist or a label, so it commits
    // to neither — and leaves `role` at the schema default.
    expect(data.artist).toBeUndefined();
    expect(data.role).toBeUndefined();
  });
});
