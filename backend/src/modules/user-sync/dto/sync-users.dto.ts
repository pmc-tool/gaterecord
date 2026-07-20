import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsObject,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GlobalUserMeta } from '@database/entities/global-user.entity';

/**
 * Upper bound on a single ingest batch. The upstream account service pushes in
 * small pages (batchSize = 5 at time of writing), so this is only a guard rail
 * against an unbounded payload.
 */
export const MAX_USERS_PER_SYNC_REQUEST = 500;

/**
 * The account service emits `email: ''` for users with no address, so an empty
 * string must be treated as "absent" rather than failing `@IsEmail`.
 */
function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * A single upstream user record.
 *
 * The upstream payload is a flat, snake_case object owned by the account
 * service, and we mirror it verbatim into `userMeta`. The global ValidationPipe
 * runs with `whitelist: true`, which strips undecorated properties from any
 * object it validates - so the raw payload is captured into the *decorated*
 * `userMeta` property up front. class-validator does not descend into a plain
 * object behind `@IsObject()`, so the mirrored payload survives whitelisting
 * intact and new upstream fields keep flowing through without a code change.
 */
export class SyncUserDto {
  @ApiProperty({ description: 'Upstream account service user id', format: 'uuid' })
  @IsUUID()
  id: string;

  @ApiPropertyOptional({ description: 'Primary email address' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Whether the upstream account is active' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ description: 'Full upstream profile payload, mirrored verbatim' })
  @IsObject()
  userMeta: GlobalUserMeta;

  /**
   * Builds a validatable instance from a raw upstream entry, keeping the whole
   * entry as the mirrored metadata.
   */
  static fromRaw(raw: Record<string, unknown>): SyncUserDto {
    const dto = new SyncUserDto();

    dto.id = typeof raw.id === 'string' ? raw.id.trim() : (raw.id as string);

    const email = normalizeEmail(raw.email);
    if (email !== undefined) {
      dto.email = email;
    }

    const isActive = raw.isActive ?? raw.is_active;
    if (typeof isActive === 'boolean') {
      dto.isActive = isActive;
    }

    dto.userMeta = raw as GlobalUserMeta;

    return dto;
  }
}

export class SyncUsersDto {
  /**
   * `null` / `undefined` holes are dropped before validation runs.
   *
   * This is not hypothetical: the account service builds its batch with
   * `users.map(async (u) => { if (u.profile_type === USER) return dto; })`,
   * which yields `undefined` for every non-USER row. Left in place those holes
   * would fail `@ValidateNested` and reject the entire batch, so they are
   * filtered here and simply skipped.
   */
  @ApiProperty({ type: () => [SyncUserDto] })
  @IsArray()
  @ArrayMaxSize(MAX_USERS_PER_SYNC_REQUEST)
  @ValidateNested({ each: true })
  // `@Type` is required alongside `@Transform`: main.ts enables
  // `enableImplicitConversion`, and without a declared element type
  // class-transformer post-processes the transform result and discards it,
  // silently yielding an empty array.
  @Type(() => SyncUserDto)
  @Transform(({ value }) => {
    if (!Array.isArray(value)) {
      return value;
    }
    return value
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null &&
          entry !== undefined &&
          typeof entry === 'object' &&
          !Array.isArray(entry),
      )
      .map((entry) => SyncUserDto.fromRaw(entry));
  })
  users: SyncUserDto[];
}

export interface SyncUsersResult {
  /** Entries received in the request body, including unusable ones. */
  received: number;
  /** Rows written to the global users mirror. */
  upserted: number;
  /** Entries dropped: null holes, missing id/email, or superseded duplicates. */
  skipped: number;
  /** Rows that could not be persisted (e.g. a conflicting unique constraint). */
  failed: number;
}
