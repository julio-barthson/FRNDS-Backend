import slugify from 'slugify';

/**
 * "Burna Boy" → "burna-boy", or "burna-boy-2" if that is taken.
 *
 * Slugs are public and unique per table, so uniqueness has to be resolved
 * against the table rather than assumed. The caller supplies the lookup, which
 * keeps this free of any Prisma import and usable for artists, labels and
 * anything else that grows a slug later.
 */
export async function uniqueSlug(
  source: string,
  fallback: string,
  taken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const base = slugify(source, { lower: true, strict: true }) || fallback;

  let slug = base;
  let counter = 1;
  while (await taken(slug)) {
    counter += 1;
    slug = `${base}-${counter}`;
  }

  return slug;
}
