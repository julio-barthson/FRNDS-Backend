import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateReleaseDto } from './create-release.dto';

/**
 * Everything on a draft is editable except its tracks, which have their own
 * endpoints — patching a whole track list would mean guessing which rows to
 * keep, and each track owns an uploaded file.
 */
export class UpdateReleaseDto extends PartialType(
  OmitType(CreateReleaseDto, ['tracks'] as const),
) {}
