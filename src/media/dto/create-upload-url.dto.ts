import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { AssetKind } from '../../generated/prisma/enums';

export class CreateUploadUrlDto {
  /** What the file is for. Decides the size ceiling and accepted types. */
  @IsEnum(AssetKind)
  kind: AssetKind;

  /**
   * The client's file name. Used only for the extension and for showing the
   * artist something recognisable — never as the storage key.
   * @example "final-master.wav"
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  /** @example "audio/wav" */
  @IsString()
  @MaxLength(100)
  mimeType: string;

  /**
   * Size the client is about to upload, in bytes. Checked again against the
   * stored object on confirm, so this is a fast rejection, not a guarantee.
   */
  @IsInt()
  @Min(1)
  sizeBytes: number;
}
