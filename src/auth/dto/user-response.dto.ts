import type { Prisma } from '../../generated/prisma/client';
import type {
  AccountStatus,
  AdminPosition,
  Role,
} from '../../generated/prisma/enums';

export class ArtistProfileDto {
  id: string;
  stageName: string;
  slug: string;
  legalName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  country: string | null;
  labelId: string | null;
}

export class LabelProfileDto {
  id: string;
  name: string;
  slug: string;
  country: string | null;
  logoUrl: string | null;
}

export class UserResponseDto {
  id: string;
  email: string;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string | null;
  phoneVerified: boolean;
  country: string | null;
  image: string | null;
  role: Role;
  accountStatus: AccountStatus;
  onboardingCompleted: boolean;
  mustChangePassword: boolean;
  acceptedTermsAt: Date | null;
  termsVersion: string | null;
  createdAt: Date;
  artist: ArtistProfileDto | null;
  /** Set for a LABEL account. Mutually exclusive with `artist` in practice. */
  label: LabelProfileDto | null;
  adminPosition: AdminPosition | null;
}

/** Fields to pull when a query will be handed to {@link toUserResponse}. */
export const userResponseSelect = {
  id: true,
  email: true,
  emailVerified: true,
  firstName: true,
  lastName: true,
  phoneNumber: true,
  phoneVerified: true,
  country: true,
  image: true,
  role: true,
  accountStatus: true,
  onboardingCompleted: true,
  mustChangePassword: true,
  acceptedTermsAt: true,
  termsVersion: true,
  createdAt: true,
  artist: {
    select: {
      id: true,
      stageName: true,
      slug: true,
      legalName: true,
      bio: true,
      avatarUrl: true,
      country: true,
      labelId: true,
    },
  },
  ownedLabel: {
    select: {
      id: true,
      name: true,
      slug: true,
      country: true,
      logoUrl: true,
    },
  },
  admin: { select: { position: true } },
} as const;

/** Exactly what a `findUnique({ select: userResponseSelect })` returns. */
export type SelectedUser = Prisma.UserGetPayload<{
  select: typeof userResponseSelect;
}>;

/**
 * Builds the API shape by listing what goes out, rather than stripping what
 * must not. An allow-list cannot leak a column added later.
 */
export function toUserResponse(user: SelectedUser): UserResponseDto {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    phoneNumber: user.phoneNumber ?? null,
    phoneVerified: user.phoneVerified,
    country: user.country ?? null,
    image: user.image ?? null,
    role: user.role,
    accountStatus: user.accountStatus,
    onboardingCompleted: user.onboardingCompleted,
    mustChangePassword: user.mustChangePassword,
    acceptedTermsAt: user.acceptedTermsAt ?? null,
    termsVersion: user.termsVersion ?? null,
    createdAt: user.createdAt,
    artist: user.artist
      ? {
          id: user.artist.id,
          stageName: user.artist.stageName,
          slug: user.artist.slug,
          legalName: user.artist.legalName ?? null,
          bio: user.artist.bio ?? null,
          avatarUrl: user.artist.avatarUrl ?? null,
          country: user.artist.country ?? null,
          labelId: user.artist.labelId ?? null,
        }
      : null,
    label: user.ownedLabel
      ? {
          id: user.ownedLabel.id,
          name: user.ownedLabel.name,
          slug: user.ownedLabel.slug,
          country: user.ownedLabel.country ?? null,
          logoUrl: user.ownedLabel.logoUrl ?? null,
        }
      : null,
    adminPosition: user.admin?.position ?? null,
  };
}
