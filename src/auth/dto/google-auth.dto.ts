import { IsNotEmpty, IsString } from 'class-validator';

/**
 * The app performs the Google sign-in itself and sends the resulting ID token
 * here. Deliberately not the authorization-code flow: Google issues no client
 * secret to a native app, and one shipped inside the bundle would not be
 * secret. The server re-verifies the token's signature and audience, so a
 * forged or borrowed token cannot mint a session.
 */
export class GoogleAuthDto {
  /** The `id_token` from Google, a signed JWT. */
  @IsString()
  @IsNotEmpty()
  idToken: string;
}
