/**
 * Limits imposed by the delivery pipeline rather than by us.
 *
 * These are not our preferences — they are what a distribution partner will
 * accept, and being more permissive than they are is the dangerous direction:
 * the value saves happily, then fails at delivery, in front of a reviewer
 * instead of in front of the person who typed it.
 *
 * Kept in one place because the same field was capped at three different
 * lengths across three DTOs — 120 on the roster form, 100 on profile edit, 100
 * at onboarding — so "the limit" depended on which screen you used.
 *
 * Source: LabelGrid's published artist schema, `artist_name` 2–64 and
 * `full_name` ≤64. Revisit if the partner changes; there is one number to
 * change now rather than five.
 */

/** A stage name, or a label's imprint name. LabelGrid: `artist_name`, 2–64. */
export const ARTIST_NAME_MAX = 64;

/** Minimum a DSP will accept as a name at all. */
export const ARTIST_NAME_MIN = 2;

/**
 * A legal name, for contracts and royalty paperwork. LabelGrid: `full_name`,
 * ≤64.
 */
export const LEGAL_NAME_MAX = 64;
