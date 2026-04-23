/**
 * Backfill missing payments for existing tenants
 * Fetches paid invoices from Stripe and creates payment records
 * 
 * Run: npx ts-node scripts/backfill-payments.ts
 */
import { DataSource } from 'typeorm';
import Stripe from 'stripe';
import { config } from 'dotenv';

config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
});

async function backfillPayments() {
  const ds = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  await ds.initialize();
  console.log('Connected to database');

  // Find all tenants with Stripe customers
  const tenants = await ds.query(`
    SELECT id, name, stripe_customer_id, stripe_subscription_id, subscription_plan_id, billing_cycle
    FROM tenants 
    WHERE stripe_customer_id IS NOT NULL
    ORDER BY created_at DESC
  `);

  console.log(`Found ${tenants.length} tenants with Stripe customers`);

  let created = 0;
  let skipped = 0;

  for (const tenant of tenants) {
    console.log(`\nProcessing: ${tenant.name}`);
    
    try {
      // Get all paid invoices for this customer
      const invoices = await stripe.invoices.list({
        customer: tenant.stripe_customer_id,
        status: 'paid',
        limit: 100,
        expand: ['data.charge'],
      });

      console.log(`  Found ${invoices.data.length} paid invoices`);

      for (const invoice of invoices.data) {
        // Check if payment already exists
        const existing = await ds.query(
          'SELECT id FROM payments WHERE stripe_invoice_id = $1',
          [invoice.id]
        );

        if (existing.length > 0) {
          console.log(`  Skipping invoice ${invoice.id} - already recorded`);
          skipped++;
          continue;
        }

        // Get payment method details from charge
        let paymentMethodType = null;
        let paymentMethodLast4 = null;
        let paymentMethodBrand = null;

        if (invoice.charge && typeof invoice.charge !== 'string') {
          const charge = invoice.charge as Stripe.Charge;
          if (charge.payment_method_details?.card) {
            paymentMethodType = 'card';
            paymentMethodLast4 = charge.payment_method_details.card.last4;
            paymentMethodBrand = charge.payment_method_details.card.brand;
          }
        }

        // Get billing period
        const periodStart = invoice.lines.data[0]?.period?.start 
          ? new Date(invoice.lines.data[0].period.start * 1000)
          : null;
        const periodEnd = invoice.lines.data[0]?.period?.end
          ? new Date(invoice.lines.data[0].period.end * 1000)
          : null;

        // Create payment record
        await ds.query(`
          INSERT INTO payments (
            id, tenant_id, subscription_plan_id, amount, currency,
            transaction_type, payment_type, status,
            stripe_invoice_id, stripe_subscription_id, stripe_charge_id,
            billing_period_start, billing_period_end, billing_cycle,
            payment_method_type, payment_method_last4, payment_method_brand,
            description, paid_at, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4,
            'charge', 'subscription', 'succeeded',
            $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13,
            $14, $15, NOW(), NOW()
          )
        `, [
          tenant.id,
          tenant.subscription_plan_id,
          (invoice.amount_paid || 0) / 100, // Convert to dollars
          invoice.currency || 'usd',
          invoice.id,
          invoice.subscription as string || tenant.stripe_subscription_id,
          typeof invoice.charge === 'string' ? invoice.charge : invoice.charge?.id,
          periodStart,
          periodEnd,
          tenant.billing_cycle || 'monthly',
          paymentMethodType,
          paymentMethodLast4,
          paymentMethodBrand,
          `Subscription payment (backfilled) - Invoice ${invoice.number || invoice.id}`,
          new Date((invoice.status_transitions?.paid_at || invoice.created) * 1000),
        ]);

        console.log(`  Created payment for invoice ${invoice.id} - $${(invoice.amount_paid || 0) / 100}`);
        created++;
      }
    } catch (err: any) {
      console.error(`  Error processing ${tenant.name}:`, err.message);
    }
  }

  console.log(`\n=============================`);
  console.log(`Done! Created: ${created}, Skipped: ${skipped}`);
  console.log(`=============================`);

  await ds.destroy();
}

backfillPayments().catch(console.error);
