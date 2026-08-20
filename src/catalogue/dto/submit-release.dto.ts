import { Equals, IsBoolean } from 'class-validator';

export class SubmitReleaseDto {
  /**
   * The artist ticking "I own or control the rights to this recording".
   * Must be true — this is the record that they claimed the rights, and the
   * timestamp is stored on the release.
   */
  @IsBoolean()
  @Equals(true, {
    message: 'You must confirm you own or control the rights to this recording',
  })
  confirmRights: boolean;
}
