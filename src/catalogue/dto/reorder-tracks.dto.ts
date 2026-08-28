import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class ReorderTracksDto {
  @ApiProperty({
    description:
      'Every track id on the release, in the running order they should take. Partial lists are rejected — the client sends the order it is showing, which is unambiguous and needs no merge.',
    type: [String],
    example: [
      '5f4d1b2a-0000-4000-8000-000000000002',
      '5f4d1b2a-0000-4000-8000-000000000001',
    ],
  })
  @IsArray()
  @ArrayNotEmpty()
  // The same ceiling `CreateReleaseDto` puts on tracks — the service rejects
  // anything that is not a permutation of the release anyway, but there is no
  // reason to run validation over an unbounded list first.
  @ArrayMaxSize(30)
  @IsUUID('4', { each: true })
  trackIds: string[];
}
