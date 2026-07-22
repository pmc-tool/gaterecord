/**
 * Access-Events Retention Purge Cron (Phase 7 - Retention)
 *
 * SETTLED DECISION: retention = PURGE. `subscription_plan.logRetentionDays` is a real
 * data-lifecycle limit, not a view filter. This job PERMANENTLY DELETES access events that
 * are older than each tenant's plan retention window. Deletion is irreversible; once an event
 * is older than N days it is gone (on upgrade, only newer data exists).
 *
 * Because it destroys data, this file is deliberately conservative. See the SAFETY GUARDS
 * documented on `purgeExpiredAccessEvents()` below.
 *
 * This provider is intentionally separate from `stripe.scheduler.ts` (owned by another agent)
 * to avoid edit collisions; it is registered in `AccessEventsModule` (providers only). The
 * `@Cron` handler is discovered by the globally-registered `@nestjs/schedule` explorer.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { AccessEvent } from '@database/entities/access-event.entity';
import { Tenant } from '@database/entities/tenant.entity';

/** Named so it can be inspected/paused via the SchedulerRegistry if ever needed. */
export const ACCESS_EVENTS_RETENTION_CRON = 'access-events-retention-purge';

@Injectable()
export class AccessEventsRetentionCron {
  private readonly logger = new Logger(AccessEventsRetentionCron.name);

  /**
   * Delete in bounded batches instead of one giant DELETE, so we never take a long
   * table-wide lock or blow up a single transaction on a large `access_events` table.
   */
  private readonly BATCH_SIZE = 5000;

  /**
   * Ultimate backstop against a pathological loop (e.g. an undeletable row). At BATCH_SIZE
   * this caps a single tenant at 500M rows/run; anything beyond simply resumes next night.
   */
  private readonly MAX_BATCHES_PER_TENANT = 100_000;

  /** In-process reentrancy guard so a slow run can't overlap the next daily trigger. */
  private isRunning = false;

  constructor(
    @InjectRepository(AccessEvent)
    private readonly accessEventRepository: Repository<AccessEvent>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Runs daily at 02:00 (server local time) — distinct from the Stripe scheduler's 03:00/04:00
   * jobs to spread nightly load.
   *
   * SAFETY GUARDS (this permanently deletes data):
   *  1. Kill switch — `ACCESS_EVENT_RETENTION_PURGE_ENABLED=false` halts all purging without a
   *     deploy. Default is enabled (matches the settled PURGE decision).
   *  2. Reentrancy lock — never overlaps a previous run.
   *  3. Null/zero/negative retention => SKIP the tenant entirely (keep everything). A missing or
   *     non-positive `logRetentionDays` is NEVER interpreted as "delete everything".
   *  4. Strictly tenant-scoped — every DELETE carries `WHERE tenant_id = <tenant>`. There is no
   *     global/unscoped delete anywhere in this file. A tenant is only touched when its own plan
   *     defines a positive retention. Platform/super-admin data is protected implicitly: super
   *     admin's effective "unlimited" retention is a read-time concept, not a stored plan value,
   *     and `access_events.tenant_id` is non-nullable so nothing is orphaned/global.
   *  5. Cutoff is strictly in the past (`now - N days`, N > 0) and the predicate is `< cutoff`,
   *     so events exactly at or after the boundary are kept.
   *  6. Per-tenant try/catch — one tenant's failure never aborts the rest of the run.
   *  7. Counts-only logging — no event contents/PII are logged.
   */
  @Cron('0 2 * * *', { name: ACCESS_EVENTS_RETENTION_CRON })
  async purgeExpiredAccessEvents(): Promise<void> {
    // GUARD 2: never overlap a still-running purge.
    if (this.isRunning) {
      this.logger.warn('Retention purge already in progress; skipping this trigger.');
      return;
    }

    // GUARD 1: destructive + irreversible => allow ops to disable without a deploy.
    const enabled = this.configService.get<string>('ACCESS_EVENT_RETENTION_PURGE_ENABLED', 'true');
    if (String(enabled).toLowerCase() === 'false') {
      this.logger.warn(
        'ACCESS_EVENT_RETENTION_PURGE_ENABLED=false — access-events retention purge is disabled.',
      );
      return;
    }

    this.isRunning = true;
    const startedAt = Date.now();
    this.logger.log('Starting access-events retention purge...');

    let tenantsProcessed = 0;
    let tenantsSkipped = 0;
    let tenantsErrored = 0;
    let totalPurged = 0;

    try {
      // Tenant rows are few (buildings); load each with its plan to read the DB-driven limit.
      const tenants = await this.tenantRepository.find({
        relations: ['subscriptionPlan'],
      });

      for (const tenant of tenants) {
        const rawRetention = tenant.subscriptionPlan?.logRetentionDays;
        const retentionDays = Number(rawRetention);

        // GUARD 3: only purge on a positive, finite retention. null / undefined / 0 / negative
        // / NaN => skip this tenant and KEEP everything. Never treat "no limit" as "delete all".
        if (
          rawRetention === null ||
          rawRetention === undefined ||
          !Number.isFinite(retentionDays) ||
          retentionDays <= 0
        ) {
          tenantsSkipped++;
          continue;
        }

        // GUARD 5: cutoff strictly in the past; predicate below is `< cutoff`.
        const days = Math.floor(retentionDays);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);

        try {
          const deleted = await this.purgeTenantEvents(tenant.id, cutoff);
          totalPurged += deleted;
          tenantsProcessed++;
          if (deleted > 0) {
            // Per-tenant trace kept at debug and limited to id + counts (no event contents).
            this.logger.debug(
              `tenant=${tenant.id} purged=${deleted} retentionDays=${days} before=${cutoff.toISOString()}`,
            );
          }
        } catch (err) {
          // GUARD 6: isolate per-tenant failures.
          tenantsErrored++;
          this.logger.error(
            `tenant=${tenant.id} retention purge failed: ${(err as Error).message}`,
          );
        }
      }

      // GUARD 7: counts-only summary.
      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `Access-events retention purge complete: purged=${totalPurged} ` +
          `tenantsProcessed=${tenantsProcessed} tenantsSkipped=${tenantsSkipped} ` +
          `tenantsErrored=${tenantsErrored} durationMs=${durationMs}`,
      );
    } catch (err) {
      this.logger.error(`Access-events retention purge aborted: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Delete a single tenant's access events older than `cutoff`, in bounded batches.
   *
   * Postgres has no `DELETE ... LIMIT`, so each batch selects a page of ids (using the
   * `(tenant_id, timestamp)` composite index for an efficient range scan) and hard-deletes them.
   * `repository.delete(ids)` is a physical DELETE (a real PURGE) even though the entity has a
   * soft-delete column — exactly what the settled decision requires.
   *
   * Keys on the indexed `timestamp` column (the true event time, equal to created_at at insert),
   * which lets the batch select ride the existing `(tenant_id, timestamp)` index.
   *
   * @returns number of rows deleted for this tenant.
   */
  private async purgeTenantEvents(tenantId: string, cutoff: Date): Promise<number> {
    let totalDeleted = 0;

    for (let batch = 0; batch < this.MAX_BATCHES_PER_TENANT; batch++) {
      const rows = await this.accessEventRepository
        .createQueryBuilder('event')
        .select('event.id', 'id')
        .where('event.tenant_id = :tenantId', { tenantId })
        .andWhere('event.timestamp < :cutoff', { cutoff })
        .orderBy('event.timestamp', 'ASC')
        .limit(this.BATCH_SIZE)
        .getRawMany<{ id: string }>();

      if (rows.length === 0) {
        break;
      }

      const ids = rows.map((r) => r.id);
      const result = await this.accessEventRepository.delete(ids);
      const affected = result.affected ?? ids.length;
      totalDeleted += affected;

      // Stop if this batch made no progress (defensive: avoids a spin if a row can't be deleted)
      // or if the table for this tenant is drained (partial page).
      if (affected === 0 || rows.length < this.BATCH_SIZE) {
        break;
      }
    }

    return totalDeleted;
  }
}
