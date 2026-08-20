import { IsIn, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export type AccountType = 'ARTIST' | 'LABEL';

/**
 * Chosen on the first onboarding step, which is where the profile row is
 * created. It cannot live on the signup form: a Google sign-in produces a
 * session before the user has been asked anything, so both signup paths have
 * to converge here.
 */
export class AccountTypeDto {
  @IsString()
  @IsIn(['ARTIST', 'LABEL'], {
    message: 'Choose either an artist or a label account',
  })
  accountType: AccountType;

  /**
   * The stage name for an artist, or the imprint's name for a label. Both are
   * the basis of a public URL slug.
   */
  @IsString()
  @IsNotEmpty()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  @MaxLength(100, { message: 'Name must not exceed 100 characters' })
  name: string;
}
