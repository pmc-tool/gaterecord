import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRole, UserStatus } from '../entities/user.entity';

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
