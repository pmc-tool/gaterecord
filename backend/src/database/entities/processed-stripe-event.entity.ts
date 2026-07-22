import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * Records every Stripe webhook event id we have already handled, so replayed
 * deliveries (Stripe retries any event whose endpoint did not return 2xx, and
 * occasionally re-sends) are ignored instead of processed twice.
 *
 * The webhook entry point checks `event_id` before dispatching and inserts a
 * row after the handler succeeds. See StripeService.isStripeEventProcessed /
 * markStripeEventProcessed and StripeController.handleWebhook.
 *
 * NOTE: This table is created by the explicit migration
 * 1775737100000-AddProcessedStripeEvents. The runtime idempotency read/write
 * uses parameterised raw SQL through the EntityManager (not this repository),
 * so the table is honoured as soon as the migration has run without requiring
 * the entity to be wired into StripeModule.
 */
@Entity('processed_stripe_events')
export class ProcessedStripeEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_processed_stripe_events_event_id', { unique: true })
  @Column({ name: 'event_id', unique: true })
  eventId: string;

  @Column({ nullable: true })
  type: string;

  @CreateDateColumn({ name: 'processed_at' })
  processedAt: Date;
}
