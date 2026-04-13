// Fix migrations table - mark existing migrations as completed
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function fixMigrations() {
  await dataSource.initialize();
  console.log('Connected to database');

  // Check current state
  const existing = await dataSource.query('SELECT * FROM migrations');
  console.log('Current migrations:', existing);

  // Insert migration records for already-applied migrations
  const migrations = [
    { timestamp: 1775730708595, name: 'AddPauseAndAuditLog1775730708595' },
    { timestamp: 1775731214576, name: 'AddRefundEnumTypes1775731214576' },
    { timestamp: 1775731607422, name: 'AddPaymentsTable1775731607422' },
    { timestamp: 1775732000000, name: 'AddPasswordResetTokensTable1775732000000' },
  ];

  for (const mig of migrations) {
    try {
      await dataSource.query(
        'INSERT INTO migrations (timestamp, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [mig.timestamp, mig.name]
      );
      console.log(`Marked ${mig.name} as complete`);
    } catch (e: unknown) {
      console.log(`Skipping ${mig.name}:`, (e as Error).message);
    }
  }

  // Verify
  const final = await dataSource.query('SELECT * FROM migrations ORDER BY timestamp');
  console.log('Final migrations:', final);

  await dataSource.destroy();
}

fixMigrations().catch(console.error);
