import { IsEmail, IsEnum, IsString, Length } from 'class-validator';
import { SeatRole } from '../../generated/prisma/enums';

export class InviteSeatDto {
  /** Where the invitation goes. Acceptance is matched on this address. */
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  /**
   * VIEWER reads the artist and their catalogue; MANAGER also creates and
   * edits releases for them. No default — granting write access by omission is
   * the wrong way round.
   */
  @IsEnum(SeatRole, { message: 'Access must be VIEWER or MANAGER' })
  role: SeatRole;
}

export class AcceptSeatDto {
  /** The six digits from the invitation email. */
  @IsString()
  @Length(6, 6, { message: 'Enter the 6-digit invitation code' })
  code: string;
}
