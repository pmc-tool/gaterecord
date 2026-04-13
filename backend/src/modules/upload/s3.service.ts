import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, PutObjectCommandInput } from '@aws-sdk/client-s3';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3Client: InstanceType<typeof S3Client>;
  private readonly bucket: string;
  private readonly hostUrl: string;

  constructor(private configService: ConfigService) {
    const hostUrl = this.configService.get<string>('AWS_HOST_URL', 'https://ds.manob.ai');
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID', '');
    const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY', '');
    const region = this.configService.get<string>('AWS_REGION', 'ap-southeast-1');
    this.bucket = this.configService.get<string>('AWS_BUCKET', 'manobai');
    this.hostUrl = hostUrl;

    this.s3Client = new S3Client({
      endpoint: hostUrl,
      region: region,
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
      },
      forcePathStyle: true, // Required for MinIO compatibility
    });

    this.logger.log(`S3 Service initialized with endpoint: ${hostUrl}`);
  }

  /**
   * Upload a file to S3/MinIO
   * @param file - Buffer of the file
   * @param filename - Name of the file
   * @param folder - Folder path (e.g., 'gaterecord')
   * @param contentType - MIME type of the file
   * @returns Public URL of the uploaded file
   */
  async uploadFile(
    file: Buffer,
    filename: string,
    folder: string = 'gaterecord',
    contentType: string = 'image/jpeg',
  ): Promise<string> {
    const key = `${folder}/${filename}`;

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file,
        ContentType: contentType,
        ACL: 'public-read',
      });

      await this.s3Client.send(command);

      // Return public URL: https://ds.manob.ai/bucket/gaterecord/filename.jpg
      const publicUrl = `${this.hostUrl}/${this.bucket}/${key}`;
      this.logger.log(`File uploaded successfully: ${publicUrl}`);

      return publicUrl;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to upload file: ${errorMessage}`, errorStack);
      throw error;
    }
  }

  /**
   * Upload a profile image
   * @param file - Buffer of the image file
   * @param originalFileName - Original name of the file (used for extension)
   * @returns Public URL of the uploaded profile image
   */
  async uploadProfileImage(file: Buffer, originalFileName: string): Promise<string> {
    // Extract extension from original filename
    const ext = originalFileName.split('.').pop()?.toLowerCase() || 'jpg';
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    
    if (!allowedExtensions.includes(ext)) {
      throw new Error(`Invalid file extension: ${ext}. Allowed: ${allowedExtensions.join(', ')}`);
    }

    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const filename = `${timestamp}.${ext}`;

    // Determine content type
    const contentTypeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
    };

    return this.uploadFile(file, filename, 'gaterecord', contentTypeMap[ext]);
  }
}
