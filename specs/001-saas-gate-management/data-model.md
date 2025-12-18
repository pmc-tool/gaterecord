# Data Model: SaaS Gate Management System

**Feature**: 001-saas-gate-management
**Date**: 2025-12-17
**Database**: PostgreSQL 16 with Row-Level Security

## Entity Relationship Diagram

```
┌─────────────────┐       ┌─────────────────┐
│ subscription_   │       │     tenants     │
│    plans        │◄──────│   (buildings)   │
└─────────────────┘       └────────┬────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         │                         │                         │
         ▼                         ▼                         ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│     users       │       │      gates      │       │ access_policies │
└────────┬────────┘       └────────┬────────┘       └─────────────────┘
         │                         │
    ┌────┴────┐              ┌─────┴─────┐
    │         │              │           │
    ▼         ▼              ▼           ▼
┌────────┐ ┌────────┐  ┌──────────┐ ┌──────────────┐
│ rfid_  │ │vehicles│  │  gate_   │ │sensor_status │
│ cards  │ │        │  │controllers│ │              │
└────────┘ └────────┘  └──────────┘ └──────────────┘

┌─────────────────┐       ┌─────────────────┐
│  visitor_passes │       │  access_events  │
│  (created by    │       │  (audit log)    │
│   residents)    │       │                 │
└─────────────────┘       └─────────────────┘
```

## Entities

### 1. subscription_plans

SaaS subscription plan definitions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | Plan identifier |
| name | VARCHAR(100) | NOT NULL, UNIQUE | Plan name (e.g., "Basic", "Pro") |
| max_gates | INTEGER | NOT NULL | Maximum gates allowed |
| max_users | INTEGER | NOT NULL | Maximum users allowed |
| log_retention_days | INTEGER | NOT NULL | Event log retention period |
| features | JSONB | NOT NULL | Feature flags object |
| price_monthly | DECIMAL(10,2) | | Monthly price (for display) |
| is_active | BOOLEAN | DEFAULT true | Plan available for new signups |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

**Features JSONB Example**:
```json
{
  "simulator_access": true,
  "csv_export": true,
  "device_health": true,
  "staff_scheduling": true,
  "api_access": false
}
```

---

### 2. tenants

Building/society as a tenant in the SaaS system.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | Tenant identifier |
| name | VARCHAR(200) | NOT NULL | Building/society name |
| slug | VARCHAR(100) | NOT NULL, UNIQUE | URL-friendly identifier |
| address | TEXT | | Physical address |
| contact_email | VARCHAR(255) | NOT NULL | Primary contact email |
| contact_phone | VARCHAR(50) | | Contact phone |
| subscription_plan_id | UUID | FK → subscription_plans | Active subscription |
| subscription_status | ENUM | NOT NULL | 'active', 'trial', 'expired', 'suspended' |
| subscription_expires_at | TIMESTAMP | | Subscription expiry date |
| settings | JSONB | DEFAULT '{}' | Tenant-specific settings |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

**RLS Policy**: All tenant data filtered by `tenant_id = current_setting('app.current_tenant')::uuid`

---

### 3. users

All users in the system (Super Admin, Building Admin, Security, Resident, Staff).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | User identifier |
| tenant_id | UUID | FK → tenants, NULLABLE | NULL for Super Admin |
| email | VARCHAR(255) | NOT NULL, UNIQUE | Login email |
| password_hash | VARCHAR(255) | NOT NULL | Bcrypt hash |
| role | ENUM | NOT NULL | 'super_admin', 'building_admin', 'security', 'resident_owner', 'resident_tenant', 'staff_maid', 'staff_driver' |
| first_name | VARCHAR(100) | NOT NULL | |
| last_name | VARCHAR(100) | NOT NULL | |
| phone | VARCHAR(50) | | |
| unit_number | VARCHAR(50) | | For residents - apartment/unit |
| is_active | BOOLEAN | DEFAULT true | Account active status |
| created_by | UUID | FK → users | Who created this user |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |
| last_login_at | TIMESTAMP | | |

**Indexes**:
- `idx_users_tenant` on (tenant_id)
- `idx_users_email` on (email)
- `idx_users_role` on (role)

---

### 4. gates

Physical or simulated gate.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | Gate identifier |
| tenant_id | UUID | FK → tenants, NOT NULL | Owning tenant |
| name | VARCHAR(100) | NOT NULL | Display name (e.g., "Main Entry") |
| type | ENUM | NOT NULL | 'vehicle', 'pedestrian' |
| current_state | ENUM | NOT NULL, DEFAULT 'CLOSED' | Gate state machine state |
| location | VARCHAR(200) | | Physical location description |
| is_simulation_mode | BOOLEAN | DEFAULT true | Phase-1: always true |
| is_active | BOOLEAN | DEFAULT true | Gate operational status |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

**State ENUM Values**: 'CLOSED', 'OPENING', 'OPEN', 'CLOSING', 'OBSTACLE_HOLD', 'FAULT', 'MANUAL_OVERRIDE'

**Indexes**:
- `idx_gates_tenant` on (tenant_id)

---

### 5. gate_controllers

ESP32 device or simulator instance for a gate.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | Controller identifier |
| gate_id | UUID | FK → gates, UNIQUE, NOT NULL | Associated gate |
| device_id | VARCHAR(100) | | Hardware device ID (Phase-2) |
| firmware_version | VARCHAR(50) | | Current firmware |
| connection_status | ENUM | DEFAULT 'offline' | 'online', 'offline', 'unknown' |
| last_heartbeat_at | TIMESTAMP | | Last ping from device |
| wifi_strength | INTEGER | | RSSI value (-100 to 0) |
| uptime_seconds | INTEGER | | Device uptime |
| ip_address | VARCHAR(45) | | Device IP (Phase-2) |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

---

### 6. sensor_status

Per-sensor health status for a gate.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | |
| gate_id | UUID | FK → gates, NOT NULL | Associated gate |
| sensor_type | ENUM | NOT NULL | Sensor type identifier |
| is_required | BOOLEAN | DEFAULT true | Required for gate type |
| status | ENUM | NOT NULL, DEFAULT 'unknown' | Current status |
| last_seen_at | TIMESTAMP | | Last update time |
| last_value | JSONB | | Last reported value |
| notes | TEXT | | Troubleshooting hint |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

**Sensor Type ENUM**: 'esp32_controller', 'rfid_reader', 'ir_obstacle', 'ultrasonic', 'limit_switch_open', 'limit_switch_close', 'servo_actuator', 'oled_display', 'led_buzzer'

**Status ENUM**: 'ok', 'abnormal', 'missing', 'offline', 'unknown'

**Unique Constraint**: (gate_id, sensor_type)

---

### 7. rfid_cards

Human RFID cards linked to users.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | |
| tenant_id | UUID | FK → tenants, NOT NULL | |
| user_id | UUID | FK → users, NOT NULL | Card owner |
| uid | VARCHAR(50) | NOT NULL | RFID UID (hex string) |
| label | VARCHAR(100) | | Friendly name |
| is_active | BOOLEAN | DEFAULT true | |
| schedule | JSONB | | Access schedule (for staff) |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

**Schedule JSONB Example** (for staff):
```json
{
  "monday": { "start": "08:00", "end": "18:00" },
  "tuesday": { "start": "08:00", "end": "18:00" },
  "saturday": { "start": "09:00", "end": "14:00" }
}
```

**Indexes**:
- `idx_rfid_tenant` on (tenant_id)
- `idx_rfid_uid` on (uid) - for fast lookup
- **Unique**: (tenant_id, uid)

---

### 8. vehicles

Registered vehicles with RFID.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | |
| tenant_id | UUID | FK → tenants, NOT NULL | |
| owner_id | UUID | FK → users, NOT NULL | Vehicle owner (resident) |
| rfid_uid | VARCHAR(50) | | Vehicle RFID UID |
| plate_number | VARCHAR(20) | NOT NULL | License plate |
| make | VARCHAR(50) | | Vehicle make |
| model | VARCHAR(50) | | Vehicle model |
| color | VARCHAR(30) | | Vehicle color |
| is_active | BOOLEAN | DEFAULT true | |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

**Indexes**:
- `idx_vehicles_tenant` on (tenant_id)
- `idx_vehicles_rfid` on (rfid_uid)
- **Unique**: (tenant_id, rfid_uid) WHERE rfid_uid IS NOT NULL

---

### 9. visitor_passes

QR-based visitor access passes.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | |
| tenant_id | UUID | FK → tenants, NOT NULL | |
| created_by_id | UUID | FK → users, NOT NULL | Resident who created |
| token | VARCHAR(100) | NOT NULL, UNIQUE | QR code token (signed) |
| guest_name | VARCHAR(200) | NOT NULL | Visitor name |
| guest_phone | VARCHAR(50) | | Visitor phone |
| purpose | VARCHAR(200) | | Visit purpose |
| valid_from | TIMESTAMP | NOT NULL | Start of validity |
| valid_until | TIMESTAMP | NOT NULL | End of validity |
| max_entries | INTEGER | DEFAULT 1 | Max allowed entries |
| used_entries | INTEGER | DEFAULT 0 | Entries used |
| gate_ids | UUID[] | | Authorized gates (NULL = all) |
| status | ENUM | DEFAULT 'active' | 'active', 'used', 'expired', 'cancelled' |
| qr_code_data | TEXT | | Base64 QR image |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

**Indexes**:
- `idx_passes_tenant` on (tenant_id)
- `idx_passes_token` on (token)
- `idx_passes_validity` on (valid_from, valid_until)

---

### 10. access_events

Audit log of all access attempts.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | |
| tenant_id | UUID | FK → tenants, NOT NULL | |
| gate_id | UUID | FK → gates, NOT NULL | |
| timestamp | TIMESTAMP | NOT NULL, DEFAULT NOW() | Event time |
| method | ENUM | NOT NULL | Access method |
| subject_type | ENUM | NOT NULL | Type of subject |
| subject_id | UUID | | Reference to subject |
| result | ENUM | NOT NULL | 'allowed', 'denied' |
| denial_reason | VARCHAR(200) | | If denied, why |
| operator_id | UUID | FK → users | Security guard (manual) |
| previous_state | ENUM | | Gate state before |
| new_state | ENUM | | Gate state after |
| metadata | JSONB | DEFAULT '{}' | Additional event data |
| created_at | TIMESTAMP | NOT NULL | |

**Method ENUM**: 'car_rfid', 'human_rfid', 'qr', 'web_app', 'manual'

**Subject Type ENUM**: 'vehicle', 'rfid_card', 'visitor_pass', 'user', 'unknown'

**Indexes**:
- `idx_events_tenant_gate_ts` on (tenant_id, gate_id, timestamp DESC)
- `idx_events_method` on (method)
- `idx_events_result` on (result)
- `idx_events_subject` on (subject_type, subject_id)

**Partitioning** (recommended for scale):
- Partition by RANGE on timestamp (monthly partitions)

---

### 11. access_policies

Building-level access configuration.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | |
| tenant_id | UUID | FK → tenants, UNIQUE, NOT NULL | One policy per tenant |
| default_pass_validity_hours | INTEGER | DEFAULT 4 | Default visitor pass duration |
| default_pass_max_entries | INTEGER | DEFAULT 1 | Default max entries |
| require_obstacle_sensor | BOOLEAN | DEFAULT true | Block auto-close if missing |
| allow_web_remote_open | BOOLEAN | DEFAULT true | Allow resident web open |
| web_remote_open_requires_verification | BOOLEAN | DEFAULT false | Extra verification |
| staff_default_schedule | JSONB | | Default staff schedule |
| manual_override_requires_auth | BOOLEAN | DEFAULT false | Require security auth |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

---

### 12. refresh_tokens

JWT refresh token storage for session management.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK | |
| user_id | UUID | FK → users, NOT NULL | |
| token_hash | VARCHAR(255) | NOT NULL | Hash of refresh token |
| expires_at | TIMESTAMP | NOT NULL | |
| revoked_at | TIMESTAMP | | If manually revoked |
| user_agent | VARCHAR(500) | | Browser/device info |
| ip_address | VARCHAR(45) | | Client IP |
| created_at | TIMESTAMP | NOT NULL | |

**Indexes**:
- `idx_refresh_user` on (user_id)
- `idx_refresh_token` on (token_hash)

---

## State Machine: Gate States

```
                    ┌─────────────────────────────────────────┐
                    │                                         │
                    ▼                                         │
              ┌──────────┐                                    │
      ┌───────│  CLOSED  │◄───────────────────────┐          │
      │       └────┬─────┘                        │          │
      │            │                              │          │
      │            │ open_command                 │          │
      │            ▼                              │          │
      │       ┌──────────┐    limit_switch_open   │          │
      │       │ OPENING  ├────────────────────────┤          │
      │       └────┬─────┘                        │          │
      │            │                              │          │
      │            │ limit_switch_open            │          │
      │            ▼                              │          │
      │       ┌──────────┐                        │          │
      │       │   OPEN   │                        │          │
      │       └────┬─────┘                        │          │
      │            │                              │          │
      │            │ close_command / timeout      │          │
      │            ▼                              │          │
      │       ┌──────────┐    limit_switch_close  │          │
      │       │ CLOSING  ├────────────────────────┘          │
      │       └────┬─────┘                                   │
      │            │                                         │
      │            │ obstacle_detected                       │
      │            ▼                                         │
      │       ┌──────────────┐    obstacle_cleared           │
      │       │OBSTACLE_HOLD ├───────────────────────────────┤
      │       └──────────────┘                               │
      │                                                      │
      │  any_state + fault_detected                          │
      │            │                                         │
      │            ▼                                         │
      │       ┌──────────┐    manual_reset                   │
      ├───────│  FAULT   ├───────────────────────────────────┘
      │       └──────────┘
      │
      │  any_state + manual_override
      │            │
      │            ▼
      │       ┌────────────────┐
      └───────│MANUAL_OVERRIDE │
              └────────────────┘
```

**Valid Transitions**:

| From State | To States |
|------------|-----------|
| CLOSED | OPENING, MANUAL_OVERRIDE, FAULT |
| OPENING | OPEN, OBSTACLE_HOLD, FAULT, MANUAL_OVERRIDE |
| OPEN | CLOSING, OBSTACLE_HOLD, MANUAL_OVERRIDE, FAULT |
| CLOSING | CLOSED, OBSTACLE_HOLD, FAULT, MANUAL_OVERRIDE |
| OBSTACLE_HOLD | CLOSING, MANUAL_OVERRIDE, FAULT |
| FAULT | MANUAL_OVERRIDE, CLOSED |
| MANUAL_OVERRIDE | CLOSED, OPEN, FAULT |

---

## Row-Level Security Policies

```sql
-- Enable RLS on all tenant tables
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE gate_controllers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensor_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfid_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitor_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_policies ENABLE ROW LEVEL SECURITY;

-- Example policy for gates table
CREATE POLICY tenant_isolation_gates ON gates
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Super admin bypass policy
CREATE POLICY super_admin_all_gates ON gates
  FOR ALL
  USING (current_setting('app.is_super_admin', true)::boolean = true);
```

---

## Database Initialization

```sql
-- Create ENUM types
CREATE TYPE subscription_status AS ENUM ('active', 'trial', 'expired', 'suspended');
CREATE TYPE user_role AS ENUM ('super_admin', 'building_admin', 'security', 'resident_owner', 'resident_tenant', 'staff_maid', 'staff_driver');
CREATE TYPE gate_type AS ENUM ('vehicle', 'pedestrian');
CREATE TYPE gate_state AS ENUM ('CLOSED', 'OPENING', 'OPEN', 'CLOSING', 'OBSTACLE_HOLD', 'FAULT', 'MANUAL_OVERRIDE');
CREATE TYPE connection_status AS ENUM ('online', 'offline', 'unknown');
CREATE TYPE sensor_type AS ENUM ('esp32_controller', 'rfid_reader', 'ir_obstacle', 'ultrasonic', 'limit_switch_open', 'limit_switch_close', 'servo_actuator', 'oled_display', 'led_buzzer');
CREATE TYPE sensor_health_status AS ENUM ('ok', 'abnormal', 'missing', 'offline', 'unknown');
CREATE TYPE access_method AS ENUM ('car_rfid', 'human_rfid', 'qr', 'web_app', 'manual');
CREATE TYPE subject_type AS ENUM ('vehicle', 'rfid_card', 'visitor_pass', 'user', 'unknown');
CREATE TYPE access_result AS ENUM ('allowed', 'denied');
CREATE TYPE pass_status AS ENUM ('active', 'used', 'expired', 'cancelled');

-- UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```
