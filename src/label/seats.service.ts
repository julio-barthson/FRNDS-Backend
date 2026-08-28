import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { seatInviteTemplate } from '../mail/templates';
import { PrismaService } from '../prisma/prisma.service';
import { notDeleted } from '../utils/prismaFilters';
import { InviteSeatDto } from './dto/seat.dto';

const BCRYPT_ROUNDS = 10;

/**
 * Seven days, not the ten minutes an auth OTP gets. A login code is typed
 * within a minute of asking for it; an invitation waits for someone to notice
 * an email, and expiring it overnight would mean re-issuing most of them.
 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const seatSelect = {
  id: true,
  email: true,
  role: true,
  status: true,
  acceptedAt: true,
  createdAt: true,
  artist: { select: { id: true, stageName: true } },
} as const;

@Injectable()
export class SeatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The artist must be on the caller's own roster. */
  private async rosterArtistFor(userId: string, artistId: string) {
    const label = await this.prisma.label.findUnique({
      where: { ownerId: userId },
      select: { id: true, name: true },
    });

    if (!label) {
      throw new ForbiddenException(
        'This account is not a label and has no roster',
      );
    }

    const artist = await this.prisma.artist.findFirst({
      where: { id: artistId, labelId: label.id },
      select: { id: true, stageName: true },
    });

    if (!artist) throw new NotFoundException('Artist not found');
    return { label, artist };
  }

  async list(userId: string, artistId: string) {
    await this.rosterArtistFor(userId, artistId);

    return this.prisma.artistSeat.findMany({
      where: { artistId, status: { not: 'REVOKED' } },
      select: seatSelect,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Invites someone to an artist.
   *
   * Re-inviting the same address replaces the outstanding code rather than
   * stacking a second one — `@@unique([artistId, email])` enforces it, and two
   * live codes for one seat is a support problem waiting to happen.
   */
  async invite(userId: string, artistId: string, dto: InviteSeatDto) {
    const { label, artist } = await this.rosterArtistFor(userId, artistId);
    const email = dto.email.trim().toLowerCase();

    const owner = await this.prisma.user.findFirst({
      where: { id: userId, ...notDeleted() },
      select: { email: true },
    });

    // A label inviting itself would hold a seat on its own artist, which grants
    // nothing it does not already have and makes the seat list confusing.
    if (owner?.email === email) {
      throw new BadRequestException('You already have access to this artist');
    }

    const existing = await this.prisma.artistSeat.findUnique({
      where: { artistId_email: { artistId, email } },
      select: { id: true, status: true },
    });

    if (existing?.status === 'ACTIVE') {
      throw new BadRequestException(
        'That person already has access to this artist',
      );
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const inviteCodeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const seat = await this.prisma.artistSeat.upsert({
      where: { artistId_email: { artistId, email } },
      create: {
        artistId,
        email,
        role: dto.role,
        status: 'PENDING',
        inviteCodeHash,
        expiresAt,
        invitedById: userId,
      },
      update: {
        role: dto.role,
        status: 'PENDING',
        inviteCodeHash,
        expiresAt,
        // A revoked seat being re-invited starts over: the previous holder's
        // binding must not survive a new invitation to the same address.
        userId: null,
        acceptedAt: null,
        invitedById: userId,
      },
      select: seatSelect,
    });

    // Not awaited: the seat exists either way, and a Mailjet round trip in
    // front of the reply is what made email verification look broken.
    void this.mail
      .sendMail({
        toEmail: email,
        subject: `${label.name} invited you to FRNDSHQ`,
        html: seatInviteTemplate(label.name, artist.stageName, code),
      })
      .catch(() => undefined);

    return seat;
  }

  /** Revoking is immediate: the next request the holder makes sees the change. */
  async revoke(userId: string, seatId: string) {
    const seat = await this.prisma.artistSeat.findUnique({
      where: { id: seatId },
      select: { id: true, artistId: true },
    });

    if (!seat) throw new NotFoundException('Seat not found');
    await this.rosterArtistFor(userId, seat.artistId);

    await this.prisma.artistSeat.update({
      where: { id: seatId },
      data: {
        status: 'REVOKED',
        userId: null,
        inviteCodeHash: null,
        expiresAt: null,
      },
    });

    return { id: seatId, revoked: true };
  }

  /**
   * Accepts an invitation.
   *
   * Matched on the signed-in account's own address, so a code alone is not
   * enough — it has to arrive from the mailbox it was sent to. That is why
   * there is no email field in the request.
   */
  async accept(userId: string, code: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, ...notDeleted() },
      select: {
        id: true,
        email: true,
        onboardingCompleted: true,
        artist: { select: { id: true } },
        ownedLabel: { select: { id: true } },
      },
    });

    if (!user) throw new NotFoundException('Account not found');

    const candidates = await this.prisma.artistSeat.findMany({
      where: { email: user.email, status: 'PENDING' },
      select: {
        id: true,
        inviteCodeHash: true,
        expiresAt: true,
        artistId: true,
      },
    });

    for (const seat of candidates) {
      if (!seat.inviteCodeHash || !seat.expiresAt) continue;
      if (seat.expiresAt < new Date()) continue;
      if (!(await bcrypt.compare(code, seat.inviteCodeHash))) continue;

      const accepted = await this.prisma.artistSeat.update({
        where: { id: seat.id },
        data: {
          userId,
          status: 'ACTIVE',
          acceptedAt: new Date(),
          inviteCodeHash: null,
          expiresAt: null,
        },
        select: seatSelect,
      });

      // A seat holder has no profile of their own and never will through this
      // route, so onboarding would ask them to choose artist or label and then
      // create a row nobody wanted. Marking it done sends them straight in.
      //
      // Only for an account with nothing else: someone who is already an artist
      // or a label keeps whatever state they had.
      if (!user.onboardingCompleted && !user.artist && !user.ownedLabel) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { onboardingCompleted: true },
        });
      }

      // The label sent this invitation and otherwise never learns it landed.
      // Told directly rather than through `recipientsForArtist`: the seat
      // holder who just accepted is in that set, and telling them they
      // accepted their own invitation is noise.
      const label = await this.prisma.artist.findUnique({
        where: { id: seat.artistId },
        select: {
          stageName: true,
          label: { select: { ownerId: true } },
        },
      });

      if (label?.label?.ownerId) {
        await this.notifications.notify({
          userId: label.label.ownerId,
          type: 'SEAT_ACCEPTED',
          title: 'Invitation accepted',
          body: `${user.email} now has access to ${label.stageName}.`,
        });
      }

      return accepted;
    }

    throw new BadRequestException(
      'That invitation code is not valid, has expired, or was sent to a different email address',
    );
  }

  /** What the signed-in person can reach through seats, for their own screens. */
  async mine(userId: string) {
    return this.prisma.artistSeat.findMany({
      where: { userId, status: 'ACTIVE' },
      select: seatSelect,
      orderBy: { createdAt: 'asc' },
    });
  }
}
