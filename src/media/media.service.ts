import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AssetKind } from '../generated/prisma/enums';
import {
  ASSET_RULES,
  DEFAULT_MAX_AUDIO_UPLOADS_PER_ARTIST,
  DOWNLOAD_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
} from './media.constants';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { StorageService } from './storage.service';

export interface UploadTicket {
  assetId: string;
  uploadUrl: string;
  /** The client must send this exact Content-Type on the PUT. */
  headers: Record<string, string>;
  expiresAt: Date;
  maxBytes: number;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Step 1 of the upload: reserve a row and hand back a presigned PUT so the
   * file goes straight to storage. Nothing large ever passes through the API.
   */
  async createUploadUrl(
    userId: string,
    dto: CreateUploadUrlDto,
  ): Promise<UploadTicket> {
    const rules = ASSET_RULES[dto.kind];
    const mimeType = dto.mimeType.toLowerCase().split(';')[0].trim();

    if (!rules.mimeTypes.includes(mimeType)) {
      throw new BadRequestException(
        `${mimeType} is not accepted for ${dto.kind}. Allowed: ${rules.mimeTypes.join(', ')}`,
      );
    }

    if (dto.sizeBytes > rules.maxBytes) {
      throw new BadRequestException(
        `File is too large. Maximum for ${dto.kind} is ${formatMb(rules.maxBytes)}.`,
      );
    }

    if (dto.kind === 'AUDIO') {
      await this.assertAudioQuota(userId);
    }

    const extension =
      rules.extensions[mimeType] ?? extensionFrom(dto.fileName) ?? 'bin';

    // Keys are server-generated and namespaced per user. A client-supplied
    // name would let someone write over another artist's object.
    const key = `${dto.kind.toLowerCase()}/${userId}/${randomUUID()}.${extension}`;

    const asset = await this.prisma.mediaAsset.create({
      data: {
        ownerId: userId,
        kind: dto.kind,
        bucket: this.storage.bucket,
        key,
        mimeType,
        sizeBytes: dto.sizeBytes,
        status: 'PENDING',
      },
      select: { id: true },
    });

    const uploadUrl = await this.storage.presignPut(
      key,
      mimeType,
      UPLOAD_URL_TTL_SECONDS,
    );

    return {
      assetId: asset.id,
      uploadUrl,
      headers: { 'Content-Type': mimeType },
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000),
      maxBytes: rules.maxBytes,
    };
  }

  /**
   * Step 2: the client says the PUT succeeded. We check the object is really
   * there and really that size before believing it — otherwise a client can
   * mark an upload complete without uploading anything.
   */
  async confirmUpload(userId: string, assetId: string) {
    const asset = await this.findOwnedAsset(userId, assetId);

    if (asset.status === 'UPLOADED') {
      return this.publicView(asset);
    }

    if (asset.status !== 'PENDING') {
      throw new BadRequestException(
        `This upload is ${asset.status.toLowerCase()} and cannot be confirmed`,
      );
    }

    const head = await this.storage.head(asset.key);

    if (!head) {
      throw new BadRequestException(
        'No file found for this upload. Send the file to the upload URL first.',
      );
    }

    const rules = ASSET_RULES[asset.kind];
    if (head.sizeBytes > rules.maxBytes) {
      // The declared size passed validation but the real file did not. Drop it
      // rather than leave an oversized object paid for and unusable.
      await this.storage.delete(asset.key);
      await this.prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException(
        `File is too large. Maximum for ${asset.kind} is ${formatMb(rules.maxBytes)}.`,
      );
    }

    const updated = await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        status: 'UPLOADED',
        uploadedAt: new Date(),
        sizeBytes: head.sizeBytes,
        checksum: head.etag,
        ...(head.mimeType && { mimeType: head.mimeType.split(';')[0].trim() }),
      },
    });

    return this.publicView(updated);
  }

  /** Short-lived read URL. The bucket itself stays private. */
  async getDownloadUrl(userId: string, assetId: string) {
    const asset = await this.findOwnedAsset(userId, assetId);

    if (asset.status !== 'UPLOADED') {
      throw new BadRequestException('This file has not finished uploading');
    }

    const url = await this.storage.presignGet(
      asset.key,
      DOWNLOAD_URL_TTL_SECONDS,
    );

    return {
      url,
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  /**
   * Lets an artist swap a file out before submitting. Once the release is
   * past DRAFT the file is part of a submission and stays put.
   */
  async deleteAsset(userId: string, assetId: string) {
    const asset = await this.findOwnedAsset(userId, assetId);
    await this.assertNotLocked(assetId);

    await this.storage.delete(asset.key);
    await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: 'DELETED', deletedAt: new Date() },
    });

    return { message: 'File deleted' };
  }

  async listForUser(userId: string, kind?: AssetKind) {
    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        ownerId: userId,
        status: 'UPLOADED',
        ...(kind && { kind }),
      },
      orderBy: { createdAt: 'desc' },
    });

    return assets.map((asset) => this.publicView(asset));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async findOwnedAsset(userId: string, assetId: string) {
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id: assetId },
    });

    if (!asset || asset.status === 'DELETED') {
      throw new NotFoundException('File not found');
    }

    // Same message as "not found" would be tidier, but the owner check is the
    // security boundary and a distinct error makes misuse obvious in logs.
    if (asset.ownerId !== userId) {
      throw new ForbiddenException('This file belongs to another account');
    }

    return asset;
  }

  /** Blocks deletion once the asset is attached to a submitted release. */
  private async assertNotLocked(assetId: string) {
    const [track, release] = await Promise.all([
      this.prisma.track.findFirst({
        where: { audioAssetId: assetId },
        select: { release: { select: { status: true } } },
      }),
      this.prisma.release.findFirst({
        where: { artworkAssetId: assetId },
        select: { status: true },
      }),
    ]);

    const status = track?.release.status ?? release?.status;
    if (status && status !== 'DRAFT') {
      throw new BadRequestException(
        'This file belongs to a release that has already been submitted',
      );
    }
  }

  private async assertAudioQuota(userId: string) {
    const limit = Number(
      process.env.MAX_AUDIO_UPLOADS_PER_ARTIST ??
        DEFAULT_MAX_AUDIO_UPLOADS_PER_ARTIST,
    );

    const used = await this.prisma.mediaAsset.count({
      where: {
        ownerId: userId,
        kind: 'AUDIO',
        status: { in: ['PENDING', 'UPLOADED'] },
      },
    });

    if (used >= limit) {
      throw new BadRequestException(
        `Upload limit reached (${limit} tracks). Delete an existing upload or contact support.`,
      );
    }
  }

  private publicView(asset: {
    id: string;
    kind: AssetKind;
    mimeType: string | null;
    sizeBytes: number | null;
    status: string;
    createdAt: Date;
    uploadedAt: Date | null;
  }) {
    // The bucket and key never leave the server: they are internal addressing,
    // and exposing them invites clients to build their own URLs.
    return {
      id: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      status: asset.status,
      createdAt: asset.createdAt,
      uploadedAt: asset.uploadedAt,
    };
  }
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function extensionFrom(fileName?: string): string | undefined {
  const match = /\.([a-z0-9]{1,8})$/i.exec(fileName ?? '');
  return match?.[1]?.toLowerCase();
}
