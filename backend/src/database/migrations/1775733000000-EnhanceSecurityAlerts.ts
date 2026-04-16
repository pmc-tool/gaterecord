import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnhanceSecurityAlerts1775733000000 implements MigrationInterface {
  name = 'EnhanceSecurityAlerts1775733000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Always ensure all required enums exist first (idempotent)
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "security_alert_type_enum" AS ENUM (
          'unauthorized_visitor', 'forced_entry', 'tailgating', 'suspicious_activity',
          'door_held_open', 'invalid_credential', 'repeated_denied_access',
          'after_hours_access', 'device_tamper', 'controller_offline'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "security_alert_source_enum" AS ENUM ('controller', 'system', 'resident_report', 'manual');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "security_alert_status_enum" AS ENUM ('active', 'acknowledged', 'resolved', 'false_alarm');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "security_alert_priority_enum" AS ENUM ('low', 'medium', 'high', 'critical');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // Add new enum values if they don't exist (for existing enums that may have been created with fewer values)
    const enumAdditions = [
      'door_held_open', 'invalid_credential', 'repeated_denied_access',
      'after_hours_access', 'device_tamper', 'controller_offline'
    ];
    
    for (const value of enumAdditions) {
      await queryRunner.query(`
        DO $$
        BEGIN
          ALTER TYPE "security_alert_type_enum" ADD VALUE IF NOT EXISTS '${value}';
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `);
    }

    // Check if security_alerts table exists
    const tableExists = await queryRunner.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'security_alerts'
      );
    `);

    if (!tableExists[0].exists) {
      // Create the full security_alerts table
      await queryRunner.query(`
        CREATE TABLE "security_alerts" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          "tenant_id" uuid NOT NULL,
          "gate_id" uuid,
          "device_id" uuid,
          "type" "security_alert_type_enum" NOT NULL,
          "source" "security_alert_source_enum" NOT NULL DEFAULT 'system',
          "status" "security_alert_status_enum" NOT NULL DEFAULT 'active',
          "priority" "security_alert_priority_enum" NOT NULL DEFAULT 'high',
          "title" varchar NOT NULL,
          "description" text NOT NULL,
          "access_event_id" uuid,
          "visitor_name" varchar,
          "resident_id" uuid,
          "reported_by_email" varchar,
          "gate_name" varchar,
          "acknowledged_by_id" uuid,
          "acknowledged_at" TIMESTAMP,
          "resolved_by_id" uuid,
          "resolved_at" TIMESTAMP,
          "resolution_notes" text,
          "metadata" jsonb,
          "buzzer_triggered" boolean NOT NULL DEFAULT false,
          "hardware_alarm_sent" boolean NOT NULL DEFAULT false,
          "hardware_alarm_stopped" boolean NOT NULL DEFAULT false,
          "alarm_duration_seconds" integer,
          "controller_serial" varchar,
          "credential_type" varchar,
          "credential_value" varchar,
          "escalated" boolean NOT NULL DEFAULT false,
          "escalated_at" TIMESTAMP,
          "auto_resolve_at" TIMESTAMP,
          CONSTRAINT "PK_security_alerts" PRIMARY KEY ("id")
        )
      `);

      // Add foreign key constraints
      await queryRunner.query(`
        ALTER TABLE "security_alerts" 
        ADD CONSTRAINT "FK_security_alerts_tenant" 
        FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
      `);

      await queryRunner.query(`
        ALTER TABLE "security_alerts" 
        ADD CONSTRAINT "FK_security_alerts_gate" 
        FOREIGN KEY ("gate_id") REFERENCES "gates"("id") ON DELETE SET NULL
      `);

      await queryRunner.query(`
        ALTER TABLE "security_alerts" 
        ADD CONSTRAINT "FK_security_alerts_device" 
        FOREIGN KEY ("device_id") REFERENCES "device_configs"("id") ON DELETE SET NULL
      `);

      await queryRunner.query(`
        ALTER TABLE "security_alerts" 
        ADD CONSTRAINT "FK_security_alerts_access_event" 
        FOREIGN KEY ("access_event_id") REFERENCES "access_events"("id") ON DELETE SET NULL
      `);

      await queryRunner.query(`
        ALTER TABLE "security_alerts" 
        ADD CONSTRAINT "FK_security_alerts_resident" 
        FOREIGN KEY ("resident_id") REFERENCES "users"("id") ON DELETE SET NULL
      `);

      await queryRunner.query(`
        ALTER TABLE "security_alerts" 
        ADD CONSTRAINT "FK_security_alerts_acknowledged_by" 
        FOREIGN KEY ("acknowledged_by_id") REFERENCES "users"("id") ON DELETE SET NULL
      `);

      await queryRunner.query(`
        ALTER TABLE "security_alerts" 
        ADD CONSTRAINT "FK_security_alerts_resolved_by" 
        FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL
      `);

    } else {
      // Table exists, add new columns if they don't exist
      await queryRunner.query(`
        ALTER TABLE "security_alerts" 
        ADD COLUMN IF NOT EXISTS "gate_id" uuid,
        ADD COLUMN IF NOT EXISTS "device_id" uuid,
        ADD COLUMN IF NOT EXISTS "source" "security_alert_source_enum" DEFAULT 'system',
        ADD COLUMN IF NOT EXISTS "hardware_alarm_sent" boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS "hardware_alarm_stopped" boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS "alarm_duration_seconds" integer,
        ADD COLUMN IF NOT EXISTS "controller_serial" varchar,
        ADD COLUMN IF NOT EXISTS "credential_type" varchar,
        ADD COLUMN IF NOT EXISTS "credential_value" varchar,
        ADD COLUMN IF NOT EXISTS "escalated" boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS "escalated_at" timestamp,
        ADD COLUMN IF NOT EXISTS "auto_resolve_at" timestamp
      `);

      // Add foreign key constraints if they don't exist
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_security_alerts_gate') THEN
            ALTER TABLE "security_alerts" 
            ADD CONSTRAINT "FK_security_alerts_gate" 
            FOREIGN KEY ("gate_id") REFERENCES "gates"("id") ON DELETE SET NULL;
          END IF;
        END $$;
      `);

      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_security_alerts_device') THEN
            ALTER TABLE "security_alerts" 
            ADD CONSTRAINT "FK_security_alerts_device" 
            FOREIGN KEY ("device_id") REFERENCES "device_configs"("id") ON DELETE SET NULL;
          END IF;
        END $$;
      `);
    }

    // Add indexes for better query performance (idempotent)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_security_alerts_tenant_status" 
      ON "security_alerts" ("tenant_id", "status")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_security_alerts_tenant_created" 
      ON "security_alerts" ("tenant_id", "created_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_security_alerts_gate_status" 
      ON "security_alerts" ("gate_id", "status")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_security_alerts_device_created" 
      ON "security_alerts" ("device_id", "created_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_security_alerts_source" 
      ON "security_alerts" ("source")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_security_alerts_controller_serial" 
      ON "security_alerts" ("controller_serial")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_security_alerts_controller_serial"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_security_alerts_source"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_security_alerts_device_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_security_alerts_gate_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_security_alerts_tenant_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_security_alerts_tenant_created"`);

    // Drop table entirely (this migration may have created it)
    await queryRunner.query(`DROP TABLE IF EXISTS "security_alerts" CASCADE`);
    
    // Drop enum types
    await queryRunner.query(`DROP TYPE IF EXISTS "security_alert_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "security_alert_source_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "security_alert_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "security_alert_priority_enum"`);
  }
}
