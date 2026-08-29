# LabelGrid — data model mapping

Drafted 2026-08-29, before sandbox access.

**What this is based on.** LabelGrid's published `GET /api/public/artists` response schema,
their feature and pricing pages, and FRNDSHQ's own `schema.prisma`. The **artist** section is
grounded in their actual schema. The **release** and **track** sections are inferred from DDEX
norms and their marketing copy, because we have not seen those endpoints — everything inferred is
marked `[INFERRED]` and needs confirming against the docs once we have access.

The point of this document is to turn "we'll find out during integration" into a list of
questions with known answers, and to catch the mismatches that would otherwise arrive one 422 at
a time.

---

## 1. Artist

### Direct mappings

| FRNDSHQ | LabelGrid | Notes |
| --- | --- | --- |
| `stageName` | `artist_name` | **Length mismatch — see below** |
| `legalName` | `full_name` | **Length mismatch — see below** |
| `bio` | `bio_short` / `bio_full` | They have two, we have one. Decide which ours feeds |
| `country` | `location`? | Ours is ISO-3166 alpha-2; theirs is free text ≤255. Not a clean map |
| `avatarAsset` | `photo` | They take a `FileData` object; we hold an R2 key |
| `spotifyArtistId` | `spotify_artist_id` | Exact |
| `appleMusicArtistId` | `apple_artist_id` | Exact |
| `slug` | — | Ours, for public URLs. They have `public_id` for their own |

### Two mismatches that will fail on first contact

Both are ours being **more permissive than theirs**, so existing data can already be invalid:

| Field | FRNDSHQ allows | LabelGrid accepts |
| --- | --- | --- |
| `stageName` → `artist_name` | 120 chars (`roster-artist.dto.ts`) | **2–64** |
| `legalName` → `full_name` | 200 chars | **≤64** |

Tighten our DTOs to match before any delivery runs, or the first artist with a long legal name
fails at submission rather than at entry — which is the worst place to find out. Cheap to fix now,
and it also means the error lands on the person who can correct it.

### Fields they have that we do not

**Worth collecting — small cost, real value**

- **`isni`** (exactly 16 chars) — the artist-identity equivalent of an ISRC. Labels often already
  hold one, and it improves DSP matching. One optional field on the roster form.
- **`website`** — trivial, and artists expect to be asked.
- **`default_language`** — we hold `language` on the release, not the artist. If they expect it
  per artist, we need it; if not, ours is fine. Confirm.
- **A short list of socials** — Instagram, YouTube, SoundCloud. Note their schema has **no TikTok
  field**, which is worth a raised eyebrow given how much TikTok matters here.

**Deliberately not collecting**

Their schema carries roughly twenty-five per-platform profile URLs — `beatport_url`, `juno_url`,
`bandcamp_url`, `pandora_url`, `anghami_url`, `boomplay_url`, `iheartradio_url`, `jiosaavn_url`,
`awa_url`, `netease_url`, `tencentku_url`, `tencentqq_url`, `yandex_url` and the rest.

**These are outputs of distribution, not inputs.** An artist has a Boomplay URL *because* they
were delivered to Boomplay. Asking for them on a signup form is backwards, and a form with
twenty-five URL fields is a form nobody finishes.

The exception is an artist with an existing catalogue elsewhere, where those pages already exist
and linking them helps DSP artist matching — but that is a later enrichment, not an onboarding
step, and Spotify and Apple are already covered by the two IDs we do collect.

Also skipping for now: `members` and `affiliations` (band membership and PRO affiliations — niche
until publishing matters), `preferred_url`, and `extended_metadata` (shape unknown).

---

## 2. Release `[INFERRED]`

We have no release schema from them. What follows is DDEX-normal plus what their pages advertise.

### What we already hold

`title`, `type`, `upc`, `releaseDate`, `language`, `primaryGenre`, `secondaryGenre`, `cLine`,
`pLine`, artwork, and `ReleaseContributor` rows with billing roles.

That covers most of a standard ERN release header, which is a good sign — the model was built
DDEX-shaped even though nothing has ever been delivered.

### Gaps I expect to matter

- **Territory.** We have no concept of one. Their pages advertise per-territory release dates,
  availability restrictions and commercial terms via DDEX territory codes. Every delivery needs at
  least "worldwide". Likely a default rather than a form field, but it has to exist.
- **Commercial model / price tier.** Streaming vs download vs both, and a price band. Not modelled.
  Probably another sane default.
- **Original release date**, distinct from release date, for re-releases and catalogue. Not
  modelled. Only matters if artists bring back catalogue — which the storefront brief implies
  they will.
- **Label name as displayed.** We have `labelId`; DDEX wants the label *name* on the release.
  Derivable, but confirm which one they want for a solo artist with no label.
- **Release-level parental advisory.** We hold `explicit` per track; ERN usually wants it on the
  release too. Derivable — true if any track is.

---

## 3. Track `[INFERRED]`

### What we already hold

`title`, `versionTitle`, `trackNumber`, `discNumber`, `isrc`, `explicit`, `lyrics`, audio asset,
plus measured `durationSec`, `sampleRate`, `bitDepth`, `channels` from our own validation, and
`TrackContributor` rows covering primary, featured, remixer, producer, songwriter, composer and
engineers.

The credits work done on 2026-08-28 lands well here — writer and composer credits are exactly what
a delivery needs, and we would have been retrofitting them otherwise.

### Gaps I expect to matter

- **Publisher.** We have **no publisher entity at all.** Their API lists publishers and writers as
  first-class catalogue objects. Writers we have as contributors; publishers we do not model. This
  is the largest structural gap on the track side, and it matters for publishing royalties rather
  than for delivery — so possibly deferrable, but know it is there.
- **Preview / clip start offset.** DSPs often accept a preview start time. Not modelled.
- **Track-level language.** Ours is per release. A multilingual album would need it per track.

---

## 4. Questions for the sandbox

Ordered by how much rework the answer prevents.

1. **How does audio reach them — push or pull?** Our masters sit in R2 and
   `DOWNLOAD_URL_TTL_SECONDS` is **five minutes**. If they pull from a URL, that TTL is almost
   certainly too short for a delivery job and needs a longer-lived presign on this path only.
2. **Delivery status — webhook or poll?** Decides whether we expose a public endpoint or add a job
   to the scheduler we already run for audio retries.
3. **Are `artist_name` and `full_name` really capped at 64?** If so, tighten our DTOs first.
4. **Is `location` free text or a country code?** Decides whether `country` maps across or needs a
   new field.
5. **`bio_short` vs `bio_full`** — which does a DSP actually see?
6. **Do they generate UPC and ISRC when we omit them,** and do ours take precedence when supplied?
   Their pages say automatic generation; confirm the precedence rule, because we now collect
   artist-supplied ones.
7. **Which release fields are required** that we do not hold — territory, commercial model,
   original release date.
8. **Is there a publisher requirement** for delivery, or only for publishing administration?

---

## 5. What this does not change

The review pipeline stays ours. Their QC is technical — audio, artwork, metadata validity. Ours is
editorial and rights — may this artist release this. Two different questions, and we should not
rebuild theirs.

`ReleaseStatus` already carries `DELIVERING`, `LIVE` and `TAKEN_DOWN` with nothing setting them.
This integration is what sets them.
