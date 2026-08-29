import {
  IsISO31661Alpha2,
  IsUUID,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  ARTIST_NAME_MAX,
  ARTIST_NAME_MIN,
  LEGAL_NAME_MAX,
} from '../../utils/metadata-limits';

/**
 * A roster artist is a metadata identity the label owns, not a login — which
 * is why there is no email or password here. See `Artist.userId`, nullable for
 * exactly this reason.
 */
export class CreateRosterArtistDto {
  /** The name that appears on the release. */
  @IsString()
  @MinLength(ARTIST_NAME_MIN)
  @MaxLength(ARTIST_NAME_MAX)
  stageName: string;

  /** For contracts and royalty paperwork; never shown publicly. */
  @IsOptional()
  @IsString()
  @MaxLength(LEGAL_NAME_MAX)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  /** Two-letter ISO country code. @example "NG" */
  @IsOptional()
  @IsISO31661Alpha2({ message: 'Country must be a two-letter code, e.g. NG' })
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;

  /**
   * A confirmed AVATAR upload. The bucket is private, so responses hand back a
   * signed `avatarUrl` derived from this rather than a permanent link.
   */
  @IsOptional()
  @IsUUID()
  avatarAssetId?: string;

  /**
   * The DSP artist pages this roster artist maps to. A full profile URL is
   * accepted and reduced to the id, because that is what a label actually has
   * to hand — every distributor's roster form works this way.
   *
   * @example "https://open.spotify.com/artist/3wcj11K77LjEY1PkEazffa"
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  spotifyArtistId?: string;

  /** @example "https://music.apple.com/us/artist/burna-boy/384078300" */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  appleMusicArtistId?: string;
}

/** Every field optional — a roster edit patches whatever the label changed. */
export class UpdateRosterArtistDto {
  @IsOptional()
  @IsString()
  @MinLength(ARTIST_NAME_MIN)
  @MaxLength(ARTIST_NAME_MAX)
  stageName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LEGAL_NAME_MAX)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsISO31661Alpha2({ message: 'Country must be a two-letter code, e.g. NG' })
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;

  /**
   * A confirmed AVATAR upload. The bucket is private, so responses hand back a
   * signed `avatarUrl` derived from this rather than a permanent link.
   */
  @IsOptional()
  @IsUUID()
  avatarAssetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  spotifyArtistId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  appleMusicArtistId?: string;
}
