/**
 * Fix missing QR codes for users who signed up via Stripe before the fix
 * Run: npx ts-node scripts/fix-missing-qrcodes.ts
 */
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { config } from 'dotenv';

config();

async function fixMissingQRCodes() {
  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    synchronize: false,
  });

  await dataSource.initialize();
  console.log('Connected to database');

  // Find all users without QR codes
  const result = await dataSource.query(`
    SELECT id, email, first_name, last_name, role
    FROM gate_users
    WHERE qr_code IS NULL OR qr_code = ''
  `);

  console.log(`Found ${result.length} users without QR codes`);

  for (const user of result) {
    const qrCode = `GR-${uuidv4()}`;
    await dataSource.query(
      `UPDATE gate_users SET qr_code = $1 WHERE id = $2`,
      [qrCode, user.id]
    );
    console.log(`Fixed: ${user.email} -> ${qrCode}`);
  }

  console.log('Done!');
  await dataSource.destroy();
}

fixMissingQRCodes().catch(console.error);
