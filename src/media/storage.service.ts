import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ObjectHead {
  sizeBytes: number;
  mimeType?: string;
  etag?: string;
}

/**
 * Resolved storage settings.
 *
 * Cloudflare R2 is the target, and its own variable names are accepted first;
 * the generic `S3_*` names still work so the service can point at plain S3 or
 * MinIO without code changes. R2 needs no endpoint in the environment — it is
 * derived from the account id, which is the part people get wrong by hand.
 */
function storageConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  return {
    bucket: process.env.CLOUDFLARE_BUCKET_NAME ?? process.env.S3_BUCKET,
    accessKeyId:
      process.env.CLOUDFLARE_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY_ID,
    secretAccessKey:
      process.env.CLOUDFLARE_SECRET_ACCESS_KEY ??
      process.env.S3_SECRET_ACCESS_KEY,
    endpoint:
      process.env.S3_ENDPOINT ??
      (accountId
        ? `https://${accountId}.r2.cloudflarestorage.com`
        : undefined),
  };
}

/**
 * Thin wrapper over S3, pointed at Cloudflare R2.
 *
 * The client is built lazily so the app still boots (and the test suite still
 * runs) with no storage credentials configured.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client?: S3Client;

  get bucket(): string {
    const { bucket } = storageConfig();
    if (!bucket) {
      throw new ServiceUnavailableException('File storage is not configured');
    }
    return bucket;
  }

  get isConfigured(): boolean {
    const config = storageConfig();
    return Boolean(config.bucket && config.accessKeyId && config.secretAccessKey);
  }

  private get s3(): S3Client {
    if (this.client) return this.client;

    const config = storageConfig();
    if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw new ServiceUnavailableException('File storage is not configured');
    }

    this.client = new S3Client({
      // R2 ignores the region but the SDK insists on one; "auto" is what
      // Cloudflare document.
      region: process.env.S3_REGION ?? (config.endpoint ? 'auto' : 'us-east-1'),
      ...(config.endpoint && { endpoint: config.endpoint }),
      // R2 and most S3-compatible hosts are happiest with path-style URLs.
      // Plain AWS S3 keeps the virtual-host default.
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE
        ? process.env.S3_FORCE_PATH_STYLE === 'true'
        : Boolean(config.endpoint),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    return this.client;
  }

  /**
   * Presigned PUT. Only the content type is signed — signing the length too
   * would reject an upload whose byte count shifts by one, and the real size
   * is verified against the stored object on confirm anyway.
   */
  async presignPut(
    key: string,
    mimeType: string,
    ttlSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mimeType,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  /** Returns null when the object is not there. */
  async head(key: string): Promise<ObjectHead | null> {
    try {
      const result = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      return {
        sizeBytes: Number(result.ContentLength ?? 0),
        mimeType: result.ContentType,
        etag: result.ETag?.replace(/"/g, ''),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Best-effort delete: a failure here must not break the caller's flow. */
  async delete(key: string): Promise<boolean> {
    try {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to delete ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}

function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  const name = (error as { name?: string })?.name;
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey';
}
