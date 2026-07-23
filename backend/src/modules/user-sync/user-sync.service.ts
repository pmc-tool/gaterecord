import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Repository } from 'typeorm';
import { GlobalUser } from '@database/entities/global-user.entity';
import { SyncUserDto, SyncUsersDto, SyncUsersResult } from './dto/sync-users.dto';

@Injectable()
export class UserSyncService {
  private readonly logger = new Logger(UserSyncService.name);

  /** Rows per INSERT ... ON CONFLICT statement. */
  private static readonly CHUNK_SIZE = 100;

  constructor(
    @InjectRepository(GlobalUser)
    private readonly globalUserRepository: Repository<GlobalUser>,
  ) {}

  /**
   * Idempotently mirrors upstream account users into the global users table.
   *
   * Safe to replay: rows are written with a single `INSERT ... ON CONFLICT (id)
   * DO UPDATE` per chunk, so re-sending the same batch converges on the same
   * state without duplicating rows.
   *
   * Nothing derived from a user record is logged - only aggregate counts.
   */
  async syncUsers(dto: SyncUsersDto): Promise<SyncUsersResult> {
    const entries = Array.isArray(dto?.users) ? dto.users : [];
    const syncedAt = new Date();

    // Last occurrence wins for a repeated id. Beyond being the sane merge rule,
    // Postgres rejects an ON CONFLICT DO UPDATE that touches the same row twice
    // in one statement, so duplicates must not reach the upsert.
    const rowsById = new Map<string, QueryDeepPartialEntity<GlobalUser>>();
    let skipped = 0;

    for (const entry of entries) {
      const row = this.toRow(entry, syncedAt);
      if (!row) {
        skipped += 1;
        continue;
      }
      if (rowsById.has(row.id as string)) {
        skipped += 1;
      }
      rowsById.set(row.id as string, row);
    }

    // `users.email` carries a unique index, so two ids claiming one address
    // would abort the whole statement. Keep the newest and skip the rest.
    const rowsByEmail = new Map<string, QueryDeepPartialEntity<GlobalUser>>();
    for (const row of rowsById.values()) {
      if (rowsByEmail.has(row.email as string)) {
        skipped += 1;
      }
      rowsByEmail.set(row.email as string, row);
    }

    const rows = [...rowsByEmail.values()];
    let upserted = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i += UserSyncService.CHUNK_SIZE) {
      const chunk = rows.slice(i, i + UserSyncService.CHUNK_SIZE);
      try {
        await this.upsertChunk(chunk);
        upserted += chunk.length;
      } catch {
        // One poisoned row (e.g. an email already held by a different id) must
        // not cost the whole chunk - fall back to per-row writes for this chunk
        // only, keeping the bulk path fast in the normal case.
        const outcome = await this.upsertIndividually(chunk);
        upserted += outcome.upserted;
        failed += outcome.failed;
      }
    }

    if (skipped > 0 || failed > 0) {
      this.logger.warn(
        `User sync completed with ${skipped} skipped and ${failed} failed of ${entries.length} received`,
      );
    }

    return { received: entries.length, upserted, skipped, failed };
  }

  /**
   * Normalizes one validated entry into a persistable row, or returns null when
   * the entry cannot be stored.
   *
   * Re-checks shape defensively: the DTO layer already filters null holes, but
   * this service must not assume it was reached through that pipeline.
   */
  private toRow(
    entry: SyncUserDto | null | undefined,
    syncedAt: Date,
  ): QueryDeepPartialEntity<GlobalUser> | null {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) {
      return null;
    }

    // `users.email` is NOT NULL and unique; a blank address cannot be stored
    // (and a second blank would collide), so such records are skipped.
    const email = typeof entry.email === 'string' ? entry.email.trim().toLowerCase() : '';
    if (!email) {
      return null;
    }

    // Cast: QueryDeepPartialEntity recurses into the jsonb column's open index
    // signature and cannot express "any JSON value", so the mirrored payload is
    // handed over as-is.
    return {
      id,
      email,
      userMeta: entry.userMeta ?? null,
      isActive: entry.isActive ?? true,
      syncedAt,
    } as QueryDeepPartialEntity<GlobalUser>;
  }

  private async upsertChunk(chunk: QueryDeepPartialEntity<GlobalUser>[]): Promise<void> {
    await this.globalUserRepository.upsert(chunk, {
      conflictPaths: ['id'],
      skipUpdateIfNoValuesChanged: true,
    });
  }

  private async upsertIndividually(
    chunk: QueryDeepPartialEntity<GlobalUser>[],
  ): Promise<{ upserted: number; failed: number }> {
    let upserted = 0;
    let failed = 0;

    for (const row of chunk) {
      try {
        await this.upsertChunk([row]);
        upserted += 1;
      } catch (error) {
        failed += 1;
        // Log the failure reason only - never the row, which is user PII.
        this.logger.warn(
          `Failed to mirror a user record: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    return { upserted, failed };
  }
}
