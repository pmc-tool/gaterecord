/**
 * Fix tenants that have JSON objects stored in stripe_subscription_id instead of just the ID
 * Run: npx ts-node scripts/fix-broken-subscription-ids.ts
 */
import { DataSource } from 'typeorm';
import { config } from 'dotenv';

config();

async function fixBrokenSubscriptionIds() {
  const ds = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  await ds.initialize();
  console.log('Connected to database');

  // Find tenants with JSON in stripe_subscription_id
  const result = await ds.query(`
    SELECT id, name, stripe_subscription_id 
    FROM tenants 
    WHERE stripe_subscription_id LIKE '{%'
  `);

  console.log(`Found ${result.length} tenants with broken subscription IDs`);

  for (const tenant of result) {
    try {
      const json = JSON.parse(tenant.stripe_subscription_id);
      const correctId = json.id;
      console.log(`Fixing ${tenant.name}: ${correctId}`);
      await ds.query('UPDATE tenants SET stripe_subscription_id = $1 WHERE id = $2', [correctId, tenant.id]);
    } catch (e) {
      console.error(`Error parsing for ${tenant.name}:`, e);
    }
  }

  console.log('Done!');
  await ds.destroy();
}

fixBrokenSubscriptionIds().catch(console.error);
