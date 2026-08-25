import { BadRequestException } from '@nestjs/common';
import type { ContributorRole } from '../generated/prisma/enums';

/**
 * Artist billing: turning contributor rows into the strings a store shows.
 *
 * The rule this file exists to enforce is that a title is a title. Stores
 * compose `Song (feat. Someone)` themselves from the metadata, and typing that
 * string into the title field instead is one of the most common reasons a
 * release is rejected or silently rewritten — Apple and Spotify both do it. So
 * `title` here stays "Song", the feature is a row, and the display string is
 * derived at the point it is needed.
 */

/** The roles that appear in the billing. Everything else is a credit. */
const ARTIST_ROLES: ContributorRole[] = [
  'PRIMARY_ARTIST',
  'FEATURED_ARTIST',
  'REMIXER',
];

export interface BillingContributor {
  name: string;
  role: ContributorRole;
  position: number;
}

export function isArtistRole(role: ContributorRole): boolean {
  return ARTIST_ROLES.includes(role);
}

function inOrder<T extends { position: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position);
}

/** "Asake & Olamide", or "A, B & C" past two. */
export function joinNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** The primary artists, in billing order — the line under the release title. */
export function displayArtist(contributors: BillingContributor[]): string {
  return joinNames(
    inOrder(contributors)
      .filter((row) => row.role === 'PRIMARY_ARTIST')
      .map((row) => row.name),
  );
}

/**
 * The title as a store would print it.
 *
 * Version first, then features: `Song (Chris Lake Remix) [feat. Wizkid]`. The
 * square brackets on the second bracketed part are the DDEX convention and
 * what Apple's own style guide asks for, so two parentheses do not run
 * together.
 */
export function displayTitle(
  title: string,
  versionTitle: string | null,
  contributors: BillingContributor[],
): string {
  const featured = inOrder(contributors)
    .filter((row) => row.role === 'FEATURED_ARTIST')
    .map((row) => row.name);

  let result = title;
  if (versionTitle) result += ` (${versionTitle})`;
  if (featured.length > 0) {
    const credit = `feat. ${joinNames(featured)}`;
    result += versionTitle ? ` [${credit}]` : ` (${credit})`;
  }

  return result;
}

// Catches the shapes people actually type, and only where a credit would go —
// as a bracketed aside or after a separator. A song genuinely called "Feature"
// or "Feat Of Strength" is left alone.
const TYPED_FEATURE =
  /[([\-–—/,]\s*(feat\.?|ft\.?|featuring|with)\s+\S|^\s*(feat\.?|ft\.?|featuring)\s+\S/i;

/**
 * Rejects a feature typed into a title, with a message that says where it
 * belongs instead.
 *
 * Checked on the way in rather than at submission: the artist is looking at the
 * field they just typed into, which is the only moment the correction is cheap.
 */
export function assertNoTypedFeature(title: string, field: string) {
  if (TYPED_FEATURE.test(title)) {
    throw new BadRequestException(
      `Leave the featured artist out of the ${field}. Add them under Artists instead and stores will print "(feat. …)" themselves — typed into the title, it gets the release rejected.`,
    );
  }
}

/**
 * Normalises a submitted contributor list: trims names, drops blanks, and
 * renumbers positions from the array's own order so the client never has to
 * send them.
 */
export function normaliseContributors(
  rows: {
    name: string;
    role?: ContributorRole;
    roleNote?: string;
    position?: number;
  }[],
): {
  name: string;
  role: ContributorRole;
  roleNote?: string;
  position: number;
}[] {
  return (
    rows
      .map((row) => ({ ...row, name: row.name.trim() }))
      .filter((row) => row.name.length > 0)
      // A missing position leaves every row at 0, and the sort is stable, so
      // the array's own order survives — which is what the app relies on.
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      // Fields picked out rather than spread: this goes straight into a Prisma
      // `create`, which rejects any key that is not a column.
      .map((row, index) => ({
        name: row.name,
        role: row.role ?? ('OTHER' as ContributorRole),
        roleNote: row.roleNote,
        position: index,
      }))
  );
}
