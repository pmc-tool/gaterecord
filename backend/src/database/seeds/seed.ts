import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import { SubscriptionPlan } from '../entities/subscription-plan.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import { User, UserRole, UserStatus } from '../entities/user.entity';
import { Gate, GateType, GateState } from '../entities/gate.entity';
import {
  GateController as GateControllerEntity,
  ControllerStatus,
} from '../entities/gate-controller.entity';
import { SensorStatus, SensorType, SensorHealthStatus } from '../entities/sensor-status.entity';
import { Vehicle, VehicleStatus } from '../entities/vehicle.entity';
import { RfidCard, RfidCardStatus } from '../entities/rfid-card.entity';

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

  // Clear existing data
  await dataSource.query('TRUNCATE TABLE sensor_status CASCADE');
  await dataSource.query('TRUNCATE TABLE gate_controllers CASCADE');
  await dataSource.query('TRUNCATE TABLE access_events CASCADE');
  await dataSource.query('TRUNCATE TABLE access_policies CASCADE');
  await dataSource.query('TRUNCATE TABLE visitor_passes CASCADE');
  await dataSource.query('TRUNCATE TABLE rfid_cards CASCADE');
  await dataSource.query('TRUNCATE TABLE vehicles CASCADE');
  await dataSource.query('TRUNCATE TABLE gates CASCADE');
  await dataSource.query('TRUNCATE TABLE refresh_tokens CASCADE');
  await dataSource.query('TRUNCATE TABLE users CASCADE');
  await dataSource.query('TRUNCATE TABLE tenants CASCADE');
  await dataSource.query('TRUNCATE TABLE subscription_plans CASCADE');

  const planRepo = dataSource.getRepository(SubscriptionPlan);
  const tenantRepo = dataSource.getRepository(Tenant);
  const userRepo = dataSource.getRepository(User);
  const gateRepo = dataSource.getRepository(Gate);
  const controllerRepo = dataSource.getRepository(GateControllerEntity);
  const sensorRepo = dataSource.getRepository(SensorStatus);
  const vehicleRepo = dataSource.getRepository(Vehicle);
  const rfidCardRepo = dataSource.getRepository(RfidCard);

  // Create subscription plans
  console.log('Creating subscription plans...');
  const basicPlan = await planRepo.save({
    name: 'Basic',
    maxGates: 3,
    maxUsers: 50,
    logRetentionDays: 30,
    features: { simulator_access: true, csv_export: true },
  });

  const starterPlan = await planRepo.save({
    name: 'Starter',
    maxGates: 2,
    maxUsers: 25,
    logRetentionDays: 14,
    features: { simulator_access: true },
  });

  const proPlan = await planRepo.save({
    name: 'Professional',
    maxGates: 10,
    maxUsers: 200,
    logRetentionDays: 90,
    features: { simulator_access: true, csv_export: true, api_access: true },
  });

  const enterprisePlan = await planRepo.save({
    name: 'Enterprise',
    maxGates: 50,
    maxUsers: 1000,
    logRetentionDays: 365,
    features: { simulator_access: true, csv_export: true, api_access: true, custom_branding: true },
  });

  // Create Super Admin
  console.log('Creating super admin...');
  const superAdminPassword = await bcrypt.hash('Admin123!', 10);
  await userRepo.save({
    email: 'admin@gatemanagement.com',
    passwordHash: superAdminPassword,
    firstName: 'Super',
    lastName: 'Admin',
    role: UserRole.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
    tenantId: null,
  });

  // Create sample tenant
  console.log('Creating sample tenant...');
  const tenant = await tenantRepo.save({
    name: 'Sunrise Apartments',
    slug: 'sunrise-apartments',
    contactEmail: 'contact@sunrise.com',
    contactPhone: '+1234567890',
    address: '123 Main Street, City',
    status: TenantStatus.ACTIVE,
    subscriptionPlanId: proPlan.id,
    subscriptionExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });

  // Create tenant users
  console.log('Creating tenant users...');
  const buildingAdminPassword = await bcrypt.hash('Building123!', 10);
  const buildingAdmin = await userRepo.save({
    email: 'admin@building1.com',
    passwordHash: buildingAdminPassword,
    firstName: 'Building',
    lastName: 'Admin',
    role: UserRole.BUILDING_ADMIN,
    status: UserStatus.ACTIVE,
    tenantId: tenant.id,
  });

  const securityPassword = await bcrypt.hash('Security123!', 10);
  const securityUser = await userRepo.save({
    email: 'security@building1.com',
    passwordHash: securityPassword,
    firstName: 'Security',
    lastName: 'Guard',
    role: UserRole.SECURITY,
    status: UserStatus.ACTIVE,
    tenantId: tenant.id,
  });

  const residentPassword = await bcrypt.hash('Resident123!', 10);
  const resident1 = await userRepo.save({
    email: 'john.doe@building1.com',
    passwordHash: residentPassword,
    firstName: 'John',
    lastName: 'Doe',
    role: UserRole.RESIDENT,
    status: UserStatus.ACTIVE,
    tenantId: tenant.id,
    unit: 'A-101',
    phone: '+1-555-0101',
  });

  const resident2 = await userRepo.save({
    email: 'jane.smith@building1.com',
    passwordHash: residentPassword,
    firstName: 'Jane',
    lastName: 'Smith',
    role: UserRole.RESIDENT,
    status: UserStatus.ACTIVE,
    tenantId: tenant.id,
    unit: 'A-102',
    phone: '+1-555-0102',
  });

  const resident3 = await userRepo.save({
    email: 'mike.johnson@building1.com',
    passwordHash: residentPassword,
    firstName: 'Mike',
    lastName: 'Johnson',
    role: UserRole.RESIDENT,
    status: UserStatus.ACTIVE,
    tenantId: tenant.id,
    unit: 'B-201',
    phone: '+1-555-0201',
  });

  const resident4 = await userRepo.save({
    email: 'sarah.williams@building1.com',
    passwordHash: residentPassword,
    firstName: 'Sarah',
    lastName: 'Williams',
    role: UserRole.RESIDENT,
    status: UserStatus.ACTIVE,
    tenantId: tenant.id,
    unit: 'B-202',
    phone: '+1-555-0202',
  });

  const resident5 = await userRepo.save({
    email: 'david.brown@building1.com',
    passwordHash: residentPassword,
    firstName: 'David',
    lastName: 'Brown',
    role: UserRole.RESIDENT,
    status: UserStatus.ACTIVE,
    tenantId: tenant.id,
    unit: 'C-301',
    phone: '+1-555-0301',
  });

  // Create gates
  console.log('Creating gates...');
  const mainGate = await gateRepo.save({
    name: 'Main Entry',
    type: GateType.VEHICLE,
    location: 'Front Entrance',
    description: 'Main vehicle entry point',
    state: GateState.CLOSED,
    isOnline: true,
    tenantId: tenant.id,
  });

  const pedestrianGate = await gateRepo.save({
    name: 'Pedestrian Gate',
    type: GateType.PEDESTRIAN,
    location: 'Side Entrance',
    description: 'Walking path entrance',
    state: GateState.CLOSED,
    isOnline: true,
    tenantId: tenant.id,
  });

  // Create gate controllers and sensors
  console.log('Creating gate controllers and sensors...');
  for (const gate of [mainGate, pedestrianGate]) {
    const controller = await controllerRepo.save({
      gateId: gate.id,
      macAddress: 'AA:BB:CC:DD:EE:' + Math.random().toString(16).substr(2, 2).toUpperCase(),
      firmwareVersion: '1.0.0-sim',
      status: ControllerStatus.ONLINE,
      wifiStrength: -50,
      uptimeSeconds: 86400,
      lastHeartbeatAt: new Date(),
    });

    const sensorTypes = [
      SensorType.ESP32_CONTROLLER,
      SensorType.RFID_READER,
      SensorType.IR_OBSTACLE,
      SensorType.LIMIT_SWITCH_OPEN,
      SensorType.LIMIT_SWITCH_CLOSE,
      SensorType.SERVO_ACTUATOR,
      SensorType.OLED_DISPLAY,
      SensorType.LED_BUZZER,
    ];

    if (gate.type === GateType.VEHICLE) {
      sensorTypes.push(SensorType.ULTRASONIC);
    }

    for (const sensorType of sensorTypes) {
      await sensorRepo.save({
        controllerId: controller.id,
        sensorType,
        status: SensorHealthStatus.OK,
        lastReadingAt: new Date(),
      });
    }
  }

  // Create vehicles for residents
  console.log('Creating vehicles...');

  // John Doe's vehicles
  await vehicleRepo.save({
    rfidUid: 'VH-A1B2C3D4',
    licensePlate: 'ABC-1234',
    brand: 'Toyota',
    model: 'Camry',
    color: 'White',
    status: VehicleStatus.ACTIVE,
    tenantId: tenant.id,
    ownerId: resident1.id,
  });

  await vehicleRepo.save({
    rfidUid: 'VH-E5F6G7H8',
    licensePlate: 'DEF-5678',
    brand: 'Honda',
    model: 'CR-V',
    color: 'Silver',
    status: VehicleStatus.ACTIVE,
    tenantId: tenant.id,
    ownerId: resident1.id,
  });

  // Jane Smith's vehicle
  await vehicleRepo.save({
    rfidUid: 'VH-I9J0K1L2',
    licensePlate: 'GHI-9012',
    brand: 'BMW',
    model: 'X5',
    color: 'Black',
    status: VehicleStatus.ACTIVE,
    tenantId: tenant.id,
    ownerId: resident2.id,
  });

  // Mike Johnson's vehicle
  await vehicleRepo.save({
    rfidUid: 'VH-M3N4O5P6',
    licensePlate: 'JKL-3456',
    brand: 'Ford',
    model: 'F-150',
    color: 'Blue',
    status: VehicleStatus.ACTIVE,
    tenantId: tenant.id,
    ownerId: resident3.id,
  });

  // Sarah Williams' vehicle
  await vehicleRepo.save({
    rfidUid: 'VH-Q7R8S9T0',
    licensePlate: 'MNO-7890',
    brand: 'Tesla',
    model: 'Model 3',
    color: 'Red',
    status: VehicleStatus.ACTIVE,
    tenantId: tenant.id,
    ownerId: resident4.id,
  });

  // David Brown's vehicles
  await vehicleRepo.save({
    rfidUid: 'VH-U1V2W3X4',
    licensePlate: 'PQR-1234',
    brand: 'Mercedes',
    model: 'C300',
    color: 'Gray',
    status: VehicleStatus.ACTIVE,
    tenantId: tenant.id,
    ownerId: resident5.id,
  });

  await vehicleRepo.save({
    rfidUid: 'VH-Y5Z6A7B8',
    licensePlate: 'STU-5678',
    brand: 'Audi',
    model: 'Q7',
    color: 'White',
    status: VehicleStatus.ACTIVE,
    tenantId: tenant.id,
    ownerId: resident5.id,
  });

  // Create RFID cards for pedestrian access
  console.log('Creating RFID cards...');

  // Resident cards
  await rfidCardRepo.save({
    uid: 'RF-JD-001',
    label: 'John Doe - Main Card',
    status: RfidCardStatus.ACTIVE,
    tenantId: tenant.id,
    userId: resident1.id,
  });

  await rfidCardRepo.save({
    uid: 'RF-JS-002',
    label: 'Jane Smith - Main Card',
    status: RfidCardStatus.ACTIVE,
    tenantId: tenant.id,
    userId: resident2.id,
  });

  await rfidCardRepo.save({
    uid: 'RF-MJ-003',
    label: 'Mike Johnson - Main Card',
    status: RfidCardStatus.ACTIVE,
    tenantId: tenant.id,
    userId: resident3.id,
  });

  await rfidCardRepo.save({
    uid: 'RF-SW-004',
    label: 'Sarah Williams - Main Card',
    status: RfidCardStatus.ACTIVE,
    tenantId: tenant.id,
    userId: resident4.id,
  });

  await rfidCardRepo.save({
    uid: 'RF-DB-005',
    label: 'David Brown - Main Card',
    status: RfidCardStatus.ACTIVE,
    tenantId: tenant.id,
    userId: resident5.id,
  });

  // Staff cards
  await rfidCardRepo.save({
    uid: 'RF-SEC-001',
    label: 'Security Guard - Master Card',
    status: RfidCardStatus.ACTIVE,
    tenantId: tenant.id,
    userId: securityUser.id,
  });

  await rfidCardRepo.save({
    uid: 'RF-ADM-001',
    label: 'Building Admin - Master Card',
    status: RfidCardStatus.ACTIVE,
    tenantId: tenant.id,
    userId: buildingAdmin.id,
  });

  console.log('Seeding complete!');
  console.log('');
  console.log('===========================================');
  console.log('DEFAULT CREDENTIALS');
  console.log('===========================================');
  console.log('Super Admin:    admin@gatemanagement.com / Admin123!');
  console.log('Building Admin: admin@building1.com / Building123!');
  console.log('Security:       security@building1.com / Security123!');
  console.log('');
  console.log('Residents (all use password: Resident123!)');
  console.log('  - john.doe@building1.com (Unit A-101)');
  console.log('  - jane.smith@building1.com (Unit A-102)');
  console.log('  - mike.johnson@building1.com (Unit B-201)');
  console.log('  - sarah.williams@building1.com (Unit B-202)');
  console.log('  - david.brown@building1.com (Unit C-301)');
  console.log('');
  console.log('===========================================');
  console.log('VEHICLE RFID UIDs');
  console.log('===========================================');
  console.log('  VH-A1B2C3D4  - ABC-1234 (John Doe - Toyota Camry)');
  console.log('  VH-E5F6G7H8  - DEF-5678 (John Doe - Honda CR-V)');
  console.log('  VH-I9J0K1L2  - GHI-9012 (Jane Smith - BMW X5)');
  console.log('  VH-M3N4O5P6  - JKL-3456 (Mike Johnson - Ford F-150)');
  console.log('  VH-Q7R8S9T0  - MNO-7890 (Sarah Williams - Tesla Model 3)');
  console.log('  VH-U1V2W3X4  - PQR-1234 (David Brown - Mercedes C300)');
  console.log('  VH-Y5Z6A7B8  - STU-5678 (David Brown - Audi Q7)');
  console.log('');
  console.log('===========================================');
  console.log('PEDESTRIAN RFID CARD UIDs');
  console.log('===========================================');
  console.log('  RF-JD-001   - John Doe');
  console.log('  RF-JS-002   - Jane Smith');
  console.log('  RF-MJ-003   - Mike Johnson');
  console.log('  RF-SW-004   - Sarah Williams');
  console.log('  RF-DB-005   - David Brown');
  console.log('  RF-SEC-001  - Security Guard');
  console.log('  RF-ADM-001  - Building Admin');
  console.log('===========================================');

  await dataSource.destroy();
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
