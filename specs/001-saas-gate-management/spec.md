# Feature Specification: SaaS Gate Management System

**Feature Branch**: `001-saas-gate-management`
**Created**: 2025-12-17
**Status**: Draft
**Input**: Multi-tenant SaaS system for building/society gate access control with simulation mode (Phase-1) and ESP32 hardware integration (Phase-2)

## Overview

A multi-tenant SaaS platform enabling residential buildings and societies to manage gate access for residents, staff, visitors, and vehicles. The system provides:

- **Phase-1**: Complete web panel, Flutter app UX, and backend with simulation mode (no physical hardware)
- **Phase-2**: ESP32 hardware integration as a plug-in without rewriting core logic

### Product Vision

One **responsive web application** serving all roles with role-based dashboards. Each building (tenant) manages:

- Residents (owner/tenant)
- Staff (maid/driver)
- Visitors (QR pass)
- Vehicles (car RFID)
- Gates and security operations
- Full event logs and live monitoring

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Super Admin Onboards a Building (Priority: P1)

A SaaS Super Admin creates subscription plans and onboards new buildings (tenants) to the platform. Each building receives isolated data and can configure their own gates, users, and policies.

**Why this priority**: Without tenant onboarding, no other features can function. This is the foundational capability that enables the entire SaaS model.

**Independent Test**: Can be fully tested by creating a subscription plan, onboarding a building, and verifying the building admin can log in with isolated access.

**Acceptance Scenarios**:

1. **Given** Super Admin is logged in, **When** they create a subscription plan with features and limits, **Then** the plan is available for building onboarding
2. **Given** a subscription plan exists, **When** Super Admin onboards a new building with admin details, **Then** building admin receives credentials and can access their isolated tenant space
3. **Given** two buildings are onboarded, **When** Building A admin logs in, **Then** they cannot see or access Building B's data

---

### User Story 2 - Building Admin Configures Gates and Device Health (Priority: P1)

Building Admin sets up gates (vehicle/pedestrian), views device/sensor health status, and configures expected hardware for each gate.

**Why this priority**: Gates are the core entity that everything else depends on. Device health monitoring ensures operational reliability.

**Independent Test**: Can be tested by creating a gate, viewing its health dashboard, and simulating sensor status changes.

**Acceptance Scenarios**:

1. **Given** Building Admin is logged in, **When** they create a new gate with type (vehicle/pedestrian), **Then** the gate appears in the gates list with default sensor requirements
2. **Given** a gate exists, **When** Building Admin views Device & Sensor Health page, **Then** they see status for all expected sensors (ESP32 controller, RFID reader, IR sensor, ultrasonic sensor, limit switches, servo actuator)
3. **Given** a gate is in simulation mode, **When** Admin toggles sensor "connected/missing" states in simulator, **Then** health dashboard reflects the changes immediately
4. **Given** IR obstacle sensor is marked as missing, **When** auto-close is attempted, **Then** system shows warning and restricts auto-close per policy

---

### User Story 3 - Resident Creates Visitor Pass (Priority: P2)

A resident (owner or tenant) creates a visitor pass with a QR code that allows a guest to enter through the gate within a validity window.

**Why this priority**: Visitor management is a core daily use case that drives adoption and demonstrates immediate value to residents.

**Independent Test**: Can be tested by creating a visitor pass, generating QR, and verifying the pass validates correctly within the validity window.

**Acceptance Scenarios**:

1. **Given** Resident is logged in to web dashboard, **When** they create a visitor pass with guest name and validity period, **Then** system generates a unique QR token and displays it
2. **Given** a visitor pass exists with 2-hour validity and 1 entry allowed, **When** the pass is used once, **Then** the entry count is decremented and further entries are denied
3. **Given** a visitor pass has expired, **When** security attempts to verify it, **Then** system denies access and logs the attempt

---

### User Story 4 - Security Guard Manages Gate Access (Priority: P2)

Security guard verifies visitors, manages manual gate operations, and monitors real-time gate activity from their assigned gates.

**Why this priority**: Security personnel are primary daily operators; their efficiency directly impacts resident experience.

**Independent Test**: Can be tested by logging in as security, scanning/entering a visitor code, and verifying gate opens with proper event logging.

**Acceptance Scenarios**:

1. **Given** Security is logged in and assigned to a gate, **When** they scan/enter a visitor QR code, **Then** system verifies the pass and opens the gate if valid
2. **Given** Security needs to open gate manually, **When** they use manual open control, **Then** gate opens regardless of other conditions and event is logged with operator ID
3. **Given** gate is in OBSTACLE_HOLD state, **When** Security views gate status, **Then** they see the obstruction warning and can trigger manual override
4. **Given** Security dashboard is open, **When** gate events occur, **Then** live activity feed updates in real-time

---

### User Story 5 - RFID Access for Residents and Vehicles (Priority: P2)

Residents register their personal RFID cards and vehicle RFID tags. When detected at the gate, the system automatically opens if authorized.

**Why this priority**: Automated RFID access is the primary convenience feature that differentiates from manual-only systems.

**Independent Test**: Can be tested by registering an RFID UID (simulated), triggering RFID detection in simulator, and verifying gate opens with correct event logging.

**Acceptance Scenarios**:

1. **Given** Resident is logged in, **When** they register a human RFID UID for themselves, **Then** the RFID is linked to their profile and marked active
2. **Given** Resident owns a vehicle, **When** they register car RFID UID with vehicle details, **Then** the vehicle RFID is linked and authorized for their building's gates
3. **Given** a registered car RFID is detected (simulated), **When** gate is closed, **Then** system validates the RFID, opens gate, and logs CarRFID access event
4. **Given** an unregistered RFID is detected, **When** gate processes it, **Then** access is denied and event is logged with denied result

---

### User Story 6 - Resident Opens Gate via Web (Priority: P3)

Resident uses the web dashboard to remotely open the gate (one-click open button) for themselves or guests.

**Why this priority**: Web-based remote access provides convenience but is secondary to core RFID/QR flows.

**Independent Test**: Can be tested by pressing the "Open Gate" button on web dashboard and verifying gate opens with App method logged.

**Acceptance Scenarios**:

1. **Given** Resident is logged in to web dashboard, **When** they click "Open Gate" button, **Then** gate opens and event is logged with App method
2. **Given** Resident's building has remote-open security policy enabled, **When** Resident attempts remote open, **Then** additional verification is required per policy
3. **Given** gate is in FAULT state, **When** Resident attempts remote open, **Then** system shows error and suggests contacting security

---

### User Story 7 - Staff Access with Schedule Rules (Priority: P3)

Building Admin registers staff (maid/driver) with RFID and configures access schedule rules. Staff can only access during permitted times.

**Why this priority**: Staff management adds value but is secondary to resident and visitor flows.

**Independent Test**: Can be tested by creating staff with schedule, simulating RFID detection inside and outside schedule, and verifying access allowed/denied appropriately.

**Acceptance Scenarios**:

1. **Given** Building Admin creates staff profile with RFID and schedule (Mon-Sat 8AM-6PM), **When** staff RFID detected at 9AM Monday, **Then** access is allowed
2. **Given** staff has schedule restriction, **When** staff RFID detected at 10PM (outside schedule), **Then** access is denied and event logged
3. **Given** staff schedule is modified, **When** next access attempt occurs, **Then** new schedule rules apply immediately

---

### User Story 8 - Gate Simulator for Testing (Priority: P2)

Building Admin uses Gate Simulator UI to test all gate states and sensor events without physical hardware.

**Why this priority**: Critical for Phase-1 development and testing; enables full system validation before hardware integration.

**Independent Test**: Can be tested by opening simulator, triggering various simulated events, and verifying correct state transitions and event logging.

**Acceptance Scenarios**:

1. **Given** Building Admin opens Gate Simulator for a gate, **When** they view the interface, **Then** they see current gate state (CLOSED/OPENING/OPEN/CLOSING/OBSTACLE_HOLD/FAULT/MANUAL_OVERRIDE) and control buttons
2. **Given** gate is CLOSED, **When** Admin clicks "Car RFID detected" with valid UID, **Then** gate transitions to OPENING, then OPEN, and AccessEvent is created with CarRFID method
3. **Given** gate is OPEN, **When** Admin toggles "Obstacle detected (IR)", **Then** gate enters OBSTACLE_HOLD and won't close until "Clear zone" toggled
4. **Given** Admin triggers "Limit switch OPEN reached", **When** gate is in OPENING state, **Then** gate transitions to OPEN state
5. **Given** simulator generates events, **When** viewing event logs, **Then** events are indistinguishable from real hardware events

---

### User Story 9 - Event Logging and Dashboards (Priority: P2)

Building Admin and Security view live activity feeds, search/filter historical events, and export reports.

**Why this priority**: Audit trails and reporting are essential for security compliance and operational insights.

**Independent Test**: Can be tested by generating several access events, viewing live feed, applying filters, and exporting CSV.

**Acceptance Scenarios**:

1. **Given** access events exist, **When** Building Admin views dashboard, **Then** live activity feed shows recent events with gate, method, subject, result, and timestamp
2. **Given** many events exist, **When** Admin searches by date range and access method filter, **Then** results show only matching events
3. **Given** filtered results displayed, **When** Admin clicks "Export CSV", **Then** CSV file downloads with all visible event data

---

### User Story 10 - Building Policy Configuration (Priority: P3)

Building Admin configures access policies including staff schedules, visitor pass validity defaults, manual override rules, and log retention.

**Why this priority**: Policies provide customization but system works with sensible defaults initially.

**Independent Test**: Can be tested by modifying a policy setting and verifying it affects subsequent access decisions.

**Acceptance Scenarios**:

1. **Given** Building Admin opens Policies page, **When** they set default visitor pass validity to 4 hours with 2 entries, **Then** new visitor passes use these defaults
2. **Given** policy requires obstacle sensor for auto-close, **When** obstacle sensor is missing, **Then** auto-close is disabled with warning shown
3. **Given** log retention policy is set to 90 days, **When** events older than 90 days exist, **Then** system archives/purges per retention policy

---

### Edge Cases

- What happens when a gate controller loses connectivity mid-operation? System marks controller offline, last known state preserved, manual operations still work locally if hardware present
- How does system handle simultaneous RFID and QR verification requests? Queue and process in order, prevent race conditions in gate state
- What happens when visitor pass is used exactly at expiry time? Check timestamp before processing, deny if expired at moment of scan
- How does system behave when all sensors report missing? Gate enters FAULT state, only manual override allowed
- What if subscription expires for a building? Grace period with warnings, then read-only mode, then suspension with admin-only access

---

## Requirements *(mandatory)*

### Functional Requirements

#### Multi-Tenant SaaS

- **FR-001**: System MUST support multiple subscription plans with configurable feature limits (gates, users, log retention)
- **FR-002**: System MUST isolate each building's (tenant's) data completely from other tenants
- **FR-003**: Super Admin MUST be able to create, modify, and suspend subscription plans
- **FR-004**: Super Admin MUST be able to onboard new buildings with admin credentials
- **FR-005**: System MUST track subscription status and enforce feature limits per plan

#### User & Role Management

- **FR-006**: System MUST support these roles: Super Admin, Building Admin, Security Guard, Resident (Owner/Tenant), Staff (Maid/Driver), Visitor (pass-only)
- **FR-007**: System MUST enforce role-based access control across all interfaces
- **FR-008**: Building Admin MUST be able to create and manage users within their building
- **FR-009**: Residents MUST be able to register and manage their household members

#### Gate Management

- **FR-010**: System MUST support creating gates with types: Vehicle, Pedestrian
- **FR-011**: Each gate MUST have a defined state machine: CLOSED, OPENING, OPEN, CLOSING, OBSTACLE_HOLD, FAULT, MANUAL_OVERRIDE
- **FR-012**: System MUST track expected sensors per gate based on gate type
- **FR-013**: System MUST provide Device & Sensor Health page showing status of each sensor (Connected/OK, Abnormal, Missing, Offline, Unknown)
- **FR-014**: System MUST store and display last heartbeat time, firmware version, and Wi-Fi strength for each gate controller
- **FR-015**: System MUST provide "Run Self-Test" functionality for gate diagnostics

#### Access Methods

- **FR-016**: System MUST support Human RFID registration and access verification
- **FR-017**: System MUST support Vehicle RFID registration and access verification
- **FR-018**: System MUST support Visitor QR pass creation with configurable validity window and entry count
- **FR-019**: System MUST support Web-based remote gate open (one-click button for residents)
- **FR-020**: System MUST support Manual open/close by Security (always works regardless of other conditions)

#### Gate Simulator (Phase-1)

- **FR-021**: System MUST provide Gate Simulator UI in building panel showing current gate state and all control options
- **FR-022**: Simulator MUST support triggering: Car RFID detected, Human RFID detected, Visitor QR verified, Obstacle detected (IR), Clear zone (ultrasonic), Limit switch OPEN/CLOSE reached, Manual open/close
- **FR-023**: Simulator MUST generate real Access Events in database identical to hardware events
- **FR-024**: Simulator MUST allow toggling sensor connected/missing states for testing Device Health UI

#### Event Logging

- **FR-025**: System MUST log every access attempt with: tenant_id, gate_id, timestamp, method (CarRFID/HumanRFID/QR/App/Manual), subject_type, subject_id, result (allowed/denied), operator_id (if manual), notes
- **FR-026**: System MUST capture gate state transitions in event records
- **FR-027**: System MUST provide live activity feed with real-time updates
- **FR-028**: System MUST support searching and filtering events by date, gate, method, result, subject
- **FR-029**: System MUST support CSV export of event data

#### Policies

- **FR-030**: Building Admin MUST be able to configure staff access schedule rules
- **FR-031**: Building Admin MUST be able to set visitor pass default validity and entry count
- **FR-032**: Building Admin MUST be able to configure manual override authorization rules
- **FR-033**: System MUST enforce log retention based on subscription plan tier
- **FR-034**: System MUST enforce sensor requirement policies (e.g., block auto-close if obstacle sensor missing)

#### Phase-2 Integration Readiness

- **FR-035**: System MUST define clean Gate Controller Interface endpoints: /gate/open, /gate/close, /gate/status, /gate/events
- **FR-036**: System MUST support receiving heartbeat data from controllers with uptime, firmware version, Wi-Fi strength, sensor status summary
- **FR-037**: System MUST support GET /gates/{gateId}/health and POST /gates/{gateId}/self-test endpoints
- **FR-038**: All Access Events from hardware MUST use identical structure as simulator events

---

### Key Entities

- **Tenant (Building)**: Represents a subscribed building/society with isolated data, subscription plan reference, building details, admin contacts
- **User**: Person with system access, linked to tenant, has role (Super Admin, Building Admin, Security, Resident, Staff), profile details, authentication credentials
- **Gate**: Physical or simulated gate, belongs to tenant, has type (Vehicle/Pedestrian), current state, expected sensor list, controller reference
- **Gate Controller**: Represents ESP32 device (or simulator), linked to gate, stores connection status, firmware version, last heartbeat, Wi-Fi strength
- **Sensor Status**: Per-sensor health record for a gate, includes sensor type, status code, last seen timestamp, last value, troubleshooting notes
- **Vehicle**: Registered vehicle, belongs to resident, has RFID UID, plate number, vehicle details, active status
- **RFID Card**: Human RFID card, linked to user (resident or staff), has UID, active status, optional schedule restrictions
- **Visitor Pass**: QR-based access pass, created by resident, has unique token, guest details, validity window, entry count limit, usage count
- **Access Event**: Audit record of every access attempt, includes tenant, gate, timestamp, method, subject reference, result, operator, state transition, notes
- **Access Policy**: Building-level configuration for schedules, pass defaults, sensor requirements, retention rules
- **Subscription Plan**: SaaS plan definition with features, limits, pricing tier

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Building admins can onboard and configure a new gate within 10 minutes of account creation
- **SC-002**: Residents can create and share a visitor pass in under 1 minute
- **SC-003**: Security guards can verify and grant access to visitors in under 10 seconds per transaction
- **SC-004**: System supports at least 100 concurrent users per building without performance degradation
- **SC-005**: Gate state changes reflect in dashboards and apps within 2 seconds of occurrence
- **SC-006**: 99% of access events are logged completely and accurately
- **SC-007**: Device health dashboard accurately reflects sensor status within 30 seconds of change
- **SC-008**: All simulated events are indistinguishable from hardware events in logs and reports
- **SC-009**: System maintains complete tenant data isolation (zero cross-tenant data leaks)
- **SC-010**: CSV export completes within 30 seconds for up to 10,000 events

---

## Scope Boundaries

### In Scope (Phase-1)

- Multi-tenant SaaS foundation with subscription management
- Complete user and role management
- Gate configuration and state machine (software-only)
- All access methods with simulation
- Gate Simulator UI with full event generation
- Device & Sensor Health monitoring (simulated)
- Event logging, dashboards, and reporting
- Policy configuration
- Responsive web application for all roles (Super Admin, Building Admin, Security, Resident)

### Out of Scope (Phase-1)

- Actual ESP32 hardware communication
- Real RFID reader integration
- Real sensor data collection
- Physical gate actuator control
- SMS/Email notifications for visitor passes (placeholder only)
- Payment processing for subscriptions
- Mobile push notifications

### Phase-2 Scope (Future)

- ESP32 firmware and communication protocol (MQTT recommended)
- Real sensor integration and health reporting
- Physical gate control via servo/actuator
- Real-time hardware diagnostics
- OTA firmware updates

---

## Assumptions

- Buildings have reliable internet connectivity for web application usage
- Each building has at least one person capable of serving as Building Admin
- Security guards have devices (phone/tablet/computer) with web browser access
- Residents have devices with web browser for visitor pass creation and gate access
- RFID tags used will be 13.56 MHz compatible with MFRC522 readers (for Phase-2)
- Gate operations complete within 30 seconds (reasonable timeout for state transitions)
- Each building will have between 1-10 gates typically
- Visitor passes will typically be valid for 1-24 hours

---

## Dependencies

- Authentication system for secure multi-tenant access
- Real-time communication capability for live dashboards (WebSocket/Socket.io)
- QR code generation library for visitor passes
- Database supporting multi-tenant data isolation patterns
