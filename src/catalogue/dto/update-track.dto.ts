import { PartialType } from '@nestjs/mapped-types';
import { TrackInputDto } from './create-release.dto';

export class UpdateTrackDto extends PartialType(TrackInputDto) {}
