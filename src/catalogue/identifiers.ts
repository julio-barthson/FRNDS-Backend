import { BadRequestException } from '@nestjs/common';

/**
 * ISRC and UPC handling.
 *
 * Both are supplied by the artist for now — a recording released elsewhere
 * already has an ISRC, and minting a second one for it would split its
 * royalties across two identifiers. FRNDSHQ cannot issue its own until it holds
 * an IFPI registrant code and a GS1 prefix, so these are accepted and checked
 * rather than generated.
 */

/**
 * `CC-XXX-YY-NNNNN`: two-letter country, three-character registrant, two-digit
 * year, five-digit designation. Stored without separators, which is how it is
 * delivered; the hyphens are a display convention.
 */
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/** Strips the separators people paste and uppercases what is left. */
function bare(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * A GS1 check digit: weight the digits 3 and 1 from the right, and the total
 * including the check digit must land on a multiple of ten.
 *
 * Worth verifying rather than just counting characters. A transposed pair still
 * has twelve digits and is rejected by the store, days later, with no
 * explanation the artist can act on.
 */
export function hasValidGs1CheckDigit(digits: string): boolean {
  let sum = 0;
  // Right to left so the weighting does not depend on the length, which lets
  // the same check cover UPC-A (12), EAN-13 and ITF-14.
  for (
    let i = digits.length - 1, weight = 1;
    i >= 0;
    i -= 1, weight = weight === 1 ? 3 : 1
  ) {
    sum += Number(digits[i]) * weight;
  }
  return sum % 10 === 0;
}

export interface IdentifierProblem {
  message: string;
}

/** Returns the stored form, or a problem to raise. Never throws. */
export function checkIsrc(
  input: string,
): { value: string } | IdentifierProblem {
  const value = bare(input);
  if (value === '') return { value: '' };

  if (!ISRC.test(value)) {
    return {
      message:
        'An ISRC looks like CCXXXYYNNNNN — country, registrant, year, then five digits. Example: GBAYE0000001',
    };
  }

  return { value };
}

/** UPC-A, EAN-13 or ITF-14, check digit and all. */
export function checkUpc(input: string): { value: string } | IdentifierProblem {
  const value = bare(input);
  if (value === '') return { value: '' };

  if (!/^\d{12,14}$/.test(value)) {
    return { message: 'A UPC is 12 to 14 digits, with no letters.' };
  }

  if (!hasValidGs1CheckDigit(value)) {
    return {
      message:
        'That barcode’s check digit does not match, so a digit is wrong somewhere. Worth re-reading it off the source.',
    };
  }

  return { value };
}

/**
 * The form the services actually want.
 *
 * `undefined` in means "not mentioned, leave it alone"; an empty string means
 * "clear it", which has to reach the column as null rather than as '' — the
 * column is unique, and a second empty string would collide with the first.
 */
export function isrcForStorage(input?: string): string | null | undefined {
  if (input === undefined) return undefined;

  const result = checkIsrc(input);
  if ('message' in result) throw new BadRequestException(result.message);
  return result.value === '' ? null : result.value;
}

export function upcForStorage(input?: string): string | null | undefined {
  if (input === undefined) return undefined;

  const result = checkUpc(input);
  if ('message' in result) throw new BadRequestException(result.message);
  return result.value === '' ? null : result.value;
}

/**
 * Which column a unique violation was actually about.
 *
 * `meta.target` is the clean answer, but the Neon driver adapter does not
 * populate it. The fallback reads the ONE sentence Prisma writes naming the
 * fields — deliberately not a substring search over the whole message, because
 * Prisma embeds a source excerpt of the call site, and a variable named
 * `trackIsrcs` in that excerpt made every barcode clash report itself as an
 * ISRC clash. Found by trying a real duplicate; no unit test would have.
 */
function clashedFields(failure: {
  message?: string;
  meta?: { target?: string[] | string };
}): string[] {
  const target = failure.meta?.target;
  if (Array.isArray(target)) return target.map((field) => field.toLowerCase());
  if (typeof target === 'string') return [target.toLowerCase()];

  const named = /unique constraint failed on the fields: \(([^)]+)\)/i.exec(
    failure.message ?? '',
  );
  if (!named) return [];

  return named[1]
    .split(',')
    .map((field) => field.replace(/[`"\s]/g, '').toLowerCase())
    .filter(Boolean);
}

/** Turns the unique-constraint violation into something an artist can act on. */
export function describeIdentifierClash(error: unknown): string | null {
  const failure = error as {
    code?: string;
    message?: string;
    meta?: { target?: string[] | string };
  } | null;

  if (failure?.code !== 'P2002') return null;

  const fields = clashedFields(failure);

  if (fields.includes('isrc')) {
    return 'That ISRC is already on another track. An ISRC identifies one recording, so each one can only be used once.';
  }
  if (fields.includes('upc')) {
    return 'That barcode is already on another release.';
  }
  return null;
}
