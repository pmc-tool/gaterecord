/**
 * Update existing payments with net_amount and fee_amount from Stripe
 * Fetches balance transaction data to get actual fees
 * 
 * Run: npx ts-node scripts/update-payment-fees.ts
 */
import { DataSource } from 'typeorm';
import Stripe from 'stripe';
import { config } from 'dotenv';

config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
});

async function updatePaymentFees() {
  const ds = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  await ds.initialize();
  console.log('Connected to database');

  // Find all payments that have stripe_charge_id but missing net_amount
  const payments = await ds.query(`
    SELECT id, stripe_charge_id, stripe_invoice_id, amount
    FROM payments 
    WHERE stripe_charge_id IS NOT NULL 
      AND net_amount IS NULL
    ORDER BY created_at DESC
  `);

  console.log(`Found ${payments.length} payments needing fee updates`);

  let updated = 0;
  let failed = 0;

  for (const payment of payments) {
    try {
      console.log(`\nProcessing payment ${payment.id} (charge: ${payment.stripe_charge_id})`);
      
      // Retrieve the charge with balance_transaction expanded
      const charge = await stripe.charges.retrieve(payment.stripe_charge_id, {
        expand: ['balance_transaction'],
      });

      const balanceTransaction = charge.balance_transaction as Stripe.BalanceTransaction | null;
      
      if (balanceTransaction && typeof balanceTransaction === 'object') {
        const netAmount = balanceTransaction.net / 100; // Convert cents to dollars
        const feeAmount = balanceTransaction.fee / 100; // Convert cents to dollars
        
        // Update the payment record
        await ds.query(`
          UPDATE payments 
          SET 
            net_amount = $1,
            fee_amount = $2,
            updated_at = NOW()
          WHERE id = $3
        `, [netAmount, feeAmount, payment.id]);

        console.log(`  Updated: amount=$${payment.amount}, net=$${netAmount}, fee=$${feeAmount}`);
        updated++;
      } else {
        console.log(`  No balance transaction found for charge ${payment.stripe_charge_id}`);
        failed++;
      }

      // Rate limiting - Stripe allows 100 requests/second in live mode
      await new Promise(resolve => setTimeout(resolve, 100));

    } catch (err: any) {
      console.error(`  Error processing payment ${payment.id}:`, err.message);
      failed++;
    }
  }

  // Also update payments that have stripe_invoice_id but no stripe_charge_id
  const invoicePayments = await ds.query(`
    SELECT id, stripe_invoice_id, amount
    FROM payments 
    WHERE stripe_invoice_id IS NOT NULL 
      AND stripe_charge_id IS NULL
      AND net_amount IS NULL
    ORDER BY created_at DESC
  `);

  console.log(`\nFound ${invoicePayments.length} invoice-based payments needing updates`);

  for (const payment of invoicePayments) {
    try {
      console.log(`\nProcessing payment ${payment.id} (invoice: ${payment.stripe_invoice_id})`);
      
      // Retrieve the invoice with charge expanded
      const invoice = await stripe.invoices.retrieve(payment.stripe_invoice_id, {
        expand: ['charge'],
      });

      if (invoice.charge && typeof invoice.charge !== 'string') {
        const chargeId = invoice.charge.id;
        
        // Now get the charge with balance_transaction
        const charge = await stripe.charges.retrieve(chargeId, {
          expand: ['balance_transaction'],
        });

        const balanceTransaction = charge.balance_transaction as Stripe.BalanceTransaction | null;
        
        if (balanceTransaction && typeof balanceTransaction === 'object') {
          const netAmount = balanceTransaction.net / 100;
          const feeAmount = balanceTransaction.fee / 100;
          
          // Update the payment record with charge_id and fees
          await ds.query(`
            UPDATE payments 
            SET 
              stripe_charge_id = $1,
              net_amount = $2,
              fee_amount = $3,
              updated_at = NOW()
            WHERE id = $4
          `, [chargeId, netAmount, feeAmount, payment.id]);

          console.log(`  Updated: amount=$${payment.amount}, net=$${netAmount}, fee=$${feeAmount}`);
          updated++;
        }
      } else {
        console.log(`  No charge found for invoice ${payment.stripe_invoice_id}`);
        failed++;
      }

      await new Promise(resolve => setTimeout(resolve, 100));

    } catch (err: any) {
      console.error(`  Error processing payment ${payment.id}:`, err.message);
      failed++;
    }
  }

  console.log(`\n=============================`);
  console.log(`Done! Updated: ${updated}, Failed: ${failed}`);
  console.log(`=============================`);

  await ds.destroy();
}

updatePaymentFees().catch(console.error);
