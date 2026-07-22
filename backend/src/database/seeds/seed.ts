import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRole, UserStatus } from '../entities/user.entity';
import { SubscriptionPlan } from '../entities/subscription-plan.entity';

dotenv.config();

const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: [__dirname + '/../entities/*.entity{.ts,.js}'],
  synchronize: true,
});

async function seed() {
  console.log('Connecting to database...');
  await dataSource.initialize();

  console.log('Seeding database...');

  const userRepo = dataSource.getRepository(User);

  // Check if super admin already exists
  const existingAdmin = await userRepo.findOne({
    where: { email: 'admin@gaterecord.com' },
  });

  if (existingAdmin) {
    console.log('Super admin already exists, skipping...');
  } else {
    // Create Super Admin
    console.log('Creating super admin...');
    const superAdminPassword = await bcrypt.hash('Admin@123', 10);
    const qrCode = `GR-${uuidv4()}`;
    await userRepo.save({
      email: 'admin@gaterecord.com',
      passwordHash: superAdminPassword,
      firstName: 'Super',
      lastName: 'Admin',
      role: UserRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      tenantId: null,
      qrCode,
    });
  }

  // Ensure the system Default (Free) plan exists. In dev the schema comes from
  // `synchronize` (migrations are not run), so the seed is what guarantees the
  // default plan row. Idempotent: never creates a second default.
  const planRepo = dataSource.getRepository(SubscriptionPlan);
  const existingDefault = await planRepo.findOne({ where: { isDefault: true } });
  if (existingDefault) {
    console.log('Default plan already exists, skipping...');
  } else {
    const existingFree = await planRepo.findOne({ where: { name: 'Free' } });
    if (existingFree) {
      existingFree.isDefault = true;
      existingFree.isSystem = true;
      existingFree.defaultValidityDays = 60;
      await planRepo.save(existingFree);
      console.log('Promoted existing "Free" plan to the system default.');
    } else {
      console.log('Creating system Default (Free) plan...');
      await planRepo.save(
        planRepo.create({
          name: 'Free',
          description: 'Default free plan auto-assigned to new buildings',
          monthlyPrice: 0,
          yearlyPrice: 0,
          trialDays: 0,
          maxGates: 1,
          maxUsers: 3,
          maxVehicles: 10,
          maxVisitorPassesPerMonth: 20,
          logRetentionDays: 7,
          displayOrder: 0,
          isActive: true,
          isPublic: true,
          isFeatured: false,
          isDefault: true,
          isSystem: true,
          defaultValidityDays: 60,
          features: {},
        }),
      );
    }
  }

  console.log('Seeding complete!');
  console.log('');
  console.log('===========================================');
  console.log('SUPER ADMIN CREDENTIALS');
  console.log('===========================================');
  console.log('Email:    admin@gaterecord.com');
  console.log('Password: Admin@123');
  console.log('===========================================');

  await dataSource.destroy();
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
