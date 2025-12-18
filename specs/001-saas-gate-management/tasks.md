# Tasks: SaaS Gate Management System

**Input**: Design documents from `/specs/001-saas-gate-management/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested - tests omitted (add with TDD flag if needed)

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Backend**: `backend/src/` (NestJS)
- **Frontend**: `frontend/src/` (React + Ant Design)
- **Database**: `backend/src/database/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Create monorepo structure with `backend/` and `frontend/` directories
- [ ] T002 Initialize NestJS backend project with TypeScript in `backend/`
- [ ] T003 [P] Initialize React + Vite frontend project in `frontend/`
- [ ] T004 [P] Configure TypeScript strict mode in `backend/tsconfig.json`
- [ ] T005 [P] Configure TypeScript strict mode in `frontend/tsconfig.json`
- [ ] T006 [P] Setup ESLint + Prettier for backend in `backend/.eslintrc.js`
- [ ] T007 [P] Setup ESLint + Prettier for frontend in `frontend/.eslintrc.js`
- [ ] T008 [P] Configure Tailwind CSS in `frontend/tailwind.config.js`
- [ ] T009 [P] Install and configure Ant Design in `frontend/src/main.tsx`
- [ ] T010 Create environment configuration files `backend/.env.example` and `frontend/.env.example`
- [ ] T011 Setup Docker Compose for PostgreSQL development in `docker-compose.yml`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**CRITICAL**: No user story work can begin until this phase is complete

### Database Foundation

- [ ] T012 Configure TypeORM with PostgreSQL in `backend/src/app.module.ts`
- [ ] T013 Create base entity with common fields in `backend/src/database/entities/base.entity.ts`
- [ ] T014 [P] Create database ENUM types migration in `backend/src/database/migrations/001-create-enums.ts`
- [ ] T015 Create UUID extension migration in `backend/src/database/migrations/002-enable-uuid.ts`

### Authentication Module

- [ ] T016 Create User entity in `backend/src/database/entities/user.entity.ts`
- [ ] T017 Create RefreshToken entity in `backend/src/database/entities/refresh-token.entity.ts`
- [ ] T018 Create users table migration in `backend/src/database/migrations/003-create-users.ts`
- [ ] T019 Create refresh_tokens table migration in `backend/src/database/migrations/004-create-refresh-tokens.ts`
- [ ] T020 Implement AuthModule structure in `backend/src/modules/auth/auth.module.ts`
- [ ] T021 Implement AuthService with login/logout/refresh in `backend/src/modules/auth/auth.service.ts`
- [ ] T022 Implement JWT strategy in `backend/src/modules/auth/strategies/jwt.strategy.ts`
- [ ] T023 Implement AuthController in `backend/src/modules/auth/auth.controller.ts`
- [ ] T024 Create JwtAuthGuard in `backend/src/common/guards/jwt-auth.guard.ts`
- [ ] T025 Create RolesGuard for RBAC in `backend/src/common/guards/roles.guard.ts`
- [ ] T026 Create Roles decorator in `backend/src/common/decorators/roles.decorator.ts`
- [ ] T027 Create CurrentUser decorator in `backend/src/common/decorators/current-user.decorator.ts`

### Multi-Tenancy Foundation

- [ ] T028 Create SubscriptionPlan entity in `backend/src/database/entities/subscription-plan.entity.ts`
- [ ] T029 Create Tenant entity in `backend/src/database/entities/tenant.entity.ts`
- [ ] T030 Create subscription_plans table migration in `backend/src/database/migrations/005-create-subscription-plans.ts`
- [ ] T031 Create tenants table migration in `backend/src/database/migrations/006-create-tenants.ts`
- [ ] T032 Create TenantGuard for tenant isolation in `backend/src/common/guards/tenant.guard.ts`
- [ ] T033 Create TenantContext decorator in `backend/src/common/decorators/tenant.decorator.ts`
- [ ] T034 Implement tenant context middleware in `backend/src/common/middleware/tenant-context.middleware.ts`
- [ ] T035 Create RLS setup migration in `backend/src/database/migrations/007-setup-rls.ts`

### Common Infrastructure

- [ ] T036 Create global exception filter in `backend/src/common/filters/http-exception.filter.ts`
- [ ] T037 Create logging interceptor in `backend/src/common/interceptors/logging.interceptor.ts`
- [ ] T038 Create transform interceptor in `backend/src/common/interceptors/transform.interceptor.ts`
- [ ] T039 Create validation pipe configuration in `backend/src/common/pipes/validation.pipe.ts`
- [ ] T040 Setup Swagger documentation in `backend/src/main.ts`

### WebSocket Foundation

- [ ] T041 Create WebSocket gateway module in `backend/src/gateway/gateway.module.ts`
- [ ] T042 Implement base WebSocket gateway in `backend/src/gateway/app.gateway.ts`
- [ ] T043 Create WebSocket auth guard in `backend/src/gateway/guards/ws-auth.guard.ts`

### Frontend Foundation

- [ ] T044 Create AuthContext in `frontend/src/contexts/AuthContext.tsx`
- [ ] T045 Create TenantContext in `frontend/src/contexts/TenantContext.tsx`
- [ ] T046 Create API client service in `frontend/src/services/api.ts`
- [ ] T047 Create WebSocket service in `frontend/src/services/websocket.ts`
- [ ] T048 Create ProtectedRoute component in `frontend/src/components/common/ProtectedRoute.tsx`
- [ ] T049 Create RoleBasedRoute component in `frontend/src/components/common/RoleBasedRoute.tsx`
- [ ] T050 Setup React Router with role-based routes in `frontend/src/App.tsx`
- [ ] T051 Create base layout components in `frontend/src/components/common/Layout.tsx`
- [ ] T052 Create Login page in `frontend/src/pages/Login.tsx`

### Seed Data

- [ ] T053 Create seed script for Super Admin user in `backend/src/database/seeds/001-super-admin.seed.ts`
- [ ] T054 Create seed runner in `backend/src/database/seeds/seed.ts`

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Super Admin Onboards a Building (Priority: P1)

**Goal**: Super Admin creates subscription plans and onboards buildings (tenants) with isolated data access

**Independent Test**: Create a subscription plan, onboard a building, verify building admin can log in with isolated access

### Backend Implementation

- [ ] T055 [P] [US1] Create SubscriptionPlan DTOs in `backend/src/modules/tenants/dto/subscription-plan.dto.ts`
- [ ] T056 [P] [US1] Create Tenant DTOs in `backend/src/modules/tenants/dto/tenant.dto.ts`
- [ ] T057 [US1] Implement TenantsModule structure in `backend/src/modules/tenants/tenants.module.ts`
- [ ] T058 [US1] Implement SubscriptionPlanService in `backend/src/modules/tenants/services/subscription-plan.service.ts`
- [ ] T059 [US1] Implement TenantService with onboarding logic in `backend/src/modules/tenants/services/tenant.service.ts`
- [ ] T060 [US1] Implement SubscriptionPlanController (Super Admin only) in `backend/src/modules/tenants/controllers/subscription-plan.controller.ts`
- [ ] T061 [US1] Implement TenantController (Super Admin only) in `backend/src/modules/tenants/controllers/tenant.controller.ts`
- [ ] T062 [US1] Implement UsersModule structure in `backend/src/modules/users/users.module.ts`
- [ ] T063 [US1] Create User DTOs in `backend/src/modules/users/dto/user.dto.ts`
- [ ] T064 [US1] Implement UserService in `backend/src/modules/users/user.service.ts`
- [ ] T065 [US1] Implement UserController in `backend/src/modules/users/user.controller.ts`

### Frontend Implementation

- [ ] T066 [P] [US1] Create SuperAdmin layout in `frontend/src/components/layouts/SuperAdminLayout.tsx`
- [ ] T067 [P] [US1] Create subscription plan types in `frontend/src/types/subscription.ts`
- [ ] T068 [P] [US1] Create tenant types in `frontend/src/types/tenant.ts`
- [ ] T069 [US1] Create subscription plan API service in `frontend/src/services/subscriptionPlanService.ts`
- [ ] T070 [US1] Create tenant API service in `frontend/src/services/tenantService.ts`
- [ ] T071 [US1] Create SubscriptionPlanList page in `frontend/src/pages/super-admin/SubscriptionPlanList.tsx`
- [ ] T072 [US1] Create CreateSubscriptionPlan form in `frontend/src/pages/super-admin/CreateSubscriptionPlan.tsx`
- [ ] T073 [US1] Create TenantList page in `frontend/src/pages/super-admin/TenantList.tsx`
- [ ] T074 [US1] Create OnboardTenant form in `frontend/src/pages/super-admin/OnboardTenant.tsx`
- [ ] T075 [US1] Create TenantDetails page in `frontend/src/pages/super-admin/TenantDetails.tsx`
- [ ] T076 [US1] Create SuperAdmin dashboard in `frontend/src/pages/super-admin/Dashboard.tsx`

**Checkpoint**: Super Admin can create plans and onboard buildings. Building Admin can login with isolated access.

---

## Phase 4: User Story 2 - Building Admin Configures Gates and Device Health (Priority: P1)

**Goal**: Building Admin creates gates, views device/sensor health status, and configures expected hardware

**Independent Test**: Create a gate, view health dashboard, simulate sensor status changes

### Backend Implementation

- [ ] T077 [P] [US2] Create Gate entity in `backend/src/database/entities/gate.entity.ts`
- [ ] T078 [P] [US2] Create GateController entity in `backend/src/database/entities/gate-controller.entity.ts`
- [ ] T079 [P] [US2] Create SensorStatus entity in `backend/src/database/entities/sensor-status.entity.ts`
- [ ] T080 [US2] Create gates table migration in `backend/src/database/migrations/008-create-gates.ts`
- [ ] T081 [US2] Create gate_controllers table migration in `backend/src/database/migrations/009-create-gate-controllers.ts`
- [ ] T082 [US2] Create sensor_status table migration in `backend/src/database/migrations/010-create-sensor-status.ts`
- [ ] T083 [P] [US2] Create Gate DTOs in `backend/src/modules/gates/dto/gate.dto.ts`
- [ ] T084 [P] [US2] Create Health DTOs in `backend/src/modules/health/dto/health.dto.ts`
- [ ] T085 [US2] Implement GatesModule structure in `backend/src/modules/gates/gates.module.ts`
- [ ] T086 [US2] Implement GateStateMachine in `backend/src/modules/gates/services/gate-state-machine.ts`
- [ ] T087 [US2] Implement GateService in `backend/src/modules/gates/services/gate.service.ts`
- [ ] T088 [US2] Implement GateController in `backend/src/modules/gates/controllers/gate.controller.ts`
- [ ] T089 [US2] Implement HealthModule structure in `backend/src/modules/health/health.module.ts`
- [ ] T090 [US2] Implement SensorHealthService in `backend/src/modules/health/services/sensor-health.service.ts`
- [ ] T091 [US2] Implement HealthController in `backend/src/modules/health/controllers/health.controller.ts`
- [ ] T092 [US2] Add gate state change WebSocket events in `backend/src/gateway/app.gateway.ts`
- [ ] T093 [US2] Add health update WebSocket events in `backend/src/gateway/app.gateway.ts`

### Frontend Implementation

- [ ] T094 [P] [US2] Create BuildingAdmin layout in `frontend/src/components/layouts/BuildingAdminLayout.tsx`
- [ ] T095 [P] [US2] Create gate types in `frontend/src/types/gate.ts`
- [ ] T096 [P] [US2] Create health types in `frontend/src/types/health.ts`
- [ ] T097 [US2] Create gate API service in `frontend/src/services/gateService.ts`
- [ ] T098 [US2] Create health API service in `frontend/src/services/healthService.ts`
- [ ] T099 [US2] Create GateList page in `frontend/src/pages/building-admin/GateList.tsx`
- [ ] T100 [US2] Create CreateGate form in `frontend/src/pages/building-admin/CreateGate.tsx`
- [ ] T101 [US2] Create GateDetails page in `frontend/src/pages/building-admin/GateDetails.tsx`
- [ ] T102 [US2] Create SensorHealthCard component in `frontend/src/components/health/SensorHealthCard.tsx`
- [ ] T103 [US2] Create DeviceHealthDashboard component in `frontend/src/components/health/DeviceHealthDashboard.tsx`
- [ ] T104 [US2] Create GateHealthPage in `frontend/src/pages/building-admin/GateHealth.tsx`
- [ ] T105 [US2] Create useGateWebSocket hook in `frontend/src/hooks/useGateWebSocket.ts`
- [ ] T106 [US2] Create BuildingAdmin dashboard in `frontend/src/pages/building-admin/Dashboard.tsx`

**Checkpoint**: Building Admin can create gates and view device health dashboard with real-time updates.

---

## Phase 5: User Story 8 - Gate Simulator for Testing (Priority: P2)

**Goal**: Building Admin uses Gate Simulator UI to test all gate states and sensor events

**Independent Test**: Open simulator, trigger events, verify state transitions and event logging

**Note**: Implementing before other P2 stories because simulator is needed to test them

### Backend Implementation

- [ ] T107 [P] [US8] Create Simulator DTOs in `backend/src/modules/simulator/dto/simulator.dto.ts`
- [ ] T108 [US8] Implement SimulatorModule structure in `backend/src/modules/simulator/simulator.module.ts`
- [ ] T109 [US8] Implement SimulatorService in `backend/src/modules/simulator/services/simulator.service.ts`
- [ ] T110 [US8] Implement SimulatorController in `backend/src/modules/simulator/controllers/simulator.controller.ts`
- [ ] T111 [US8] Add simulator WebSocket events in `backend/src/gateway/app.gateway.ts`

### Frontend Implementation

- [ ] T112 [P] [US8] Create simulator types in `frontend/src/types/simulator.ts`
- [ ] T113 [US8] Create simulator API service in `frontend/src/services/simulatorService.ts`
- [ ] T114 [US8] Create GateStateDisplay component in `frontend/src/components/simulator/GateStateDisplay.tsx`
- [ ] T115 [US8] Create SimulatorControls component in `frontend/src/components/simulator/SimulatorControls.tsx`
- [ ] T116 [US8] Create SensorTogglePanel component in `frontend/src/components/simulator/SensorTogglePanel.tsx`
- [ ] T117 [US8] Create SimulatorPage in `frontend/src/pages/building-admin/Simulator.tsx`
- [ ] T118 [US8] Create useSimulatorWebSocket hook in `frontend/src/hooks/useSimulatorWebSocket.ts`

**Checkpoint**: Gate Simulator fully functional for testing all gate states and sensor events.

---

## Phase 6: User Story 9 - Event Logging and Dashboards (Priority: P2)

**Goal**: Building Admin and Security view live activity feeds, search/filter events, and export CSV

**Independent Test**: Generate access events, view live feed, apply filters, export CSV

### Backend Implementation

- [ ] T119 [P] [US9] Create AccessEvent entity in `backend/src/database/entities/access-event.entity.ts`
- [ ] T120 [US9] Create access_events table migration in `backend/src/database/migrations/011-create-access-events.ts`
- [ ] T121 [P] [US9] Create Event DTOs in `backend/src/modules/events/dto/event.dto.ts`
- [ ] T122 [US9] Implement EventsModule structure in `backend/src/modules/events/events.module.ts`
- [ ] T123 [US9] Implement EventService in `backend/src/modules/events/services/event.service.ts`
- [ ] T124 [US9] Implement EventQueryService with filters in `backend/src/modules/events/services/event-query.service.ts`
- [ ] T125 [US9] Implement CSV export service in `backend/src/modules/events/services/csv-export.service.ts`
- [ ] T126 [US9] Implement EventController in `backend/src/modules/events/controllers/event.controller.ts`
- [ ] T127 [US9] Add access event WebSocket emission in `backend/src/gateway/app.gateway.ts`

### Frontend Implementation

- [ ] T128 [P] [US9] Create event types in `frontend/src/types/event.ts`
- [ ] T129 [US9] Create event API service in `frontend/src/services/eventService.ts`
- [ ] T130 [US9] Create LiveEventFeed component in `frontend/src/components/events/LiveEventFeed.tsx`
- [ ] T131 [US9] Create EventTable component in `frontend/src/components/events/EventTable.tsx`
- [ ] T132 [US9] Create EventFilters component in `frontend/src/components/events/EventFilters.tsx`
- [ ] T133 [US9] Create EventsPage in `frontend/src/pages/building-admin/Events.tsx`
- [ ] T134 [US9] Create useEventWebSocket hook in `frontend/src/hooks/useEventWebSocket.ts`
- [ ] T135 [US9] Add CSV export button to EventsPage in `frontend/src/pages/building-admin/Events.tsx`

**Checkpoint**: Live event feed, filtering, and CSV export working.

---

## Phase 7: User Story 3 - Resident Creates Visitor Pass (Priority: P2)

**Goal**: Resident creates visitor pass with QR code, validates within validity window

**Independent Test**: Create visitor pass, generate QR, verify pass validates correctly

### Backend Implementation

- [ ] T136 [P] [US3] Create VisitorPass entity in `backend/src/database/entities/visitor-pass.entity.ts`
- [ ] T137 [US3] Create visitor_passes table migration in `backend/src/database/migrations/012-create-visitor-passes.ts`
- [ ] T138 [P] [US3] Create VisitorPass DTOs in `backend/src/modules/access/dto/visitor-pass.dto.ts`
- [ ] T139 [US3] Implement AccessModule structure in `backend/src/modules/access/access.module.ts`
- [ ] T140 [US3] Implement QRCodeService in `backend/src/modules/access/services/qr-code.service.ts`
- [ ] T141 [US3] Implement VisitorPassService in `backend/src/modules/access/services/visitor-pass.service.ts`
- [ ] T142 [US3] Implement VisitorPassController in `backend/src/modules/access/controllers/visitor-pass.controller.ts`

### Frontend Implementation

- [ ] T143 [P] [US3] Create ResidentLayout in `frontend/src/components/layouts/ResidentLayout.tsx`
- [ ] T144 [P] [US3] Create visitor pass types in `frontend/src/types/visitor-pass.ts`
- [ ] T145 [US3] Create visitor pass API service in `frontend/src/services/visitorPassService.ts`
- [ ] T146 [US3] Create CreateVisitorPass form in `frontend/src/pages/resident/CreateVisitorPass.tsx`
- [ ] T147 [US3] Create VisitorPassList page in `frontend/src/pages/resident/VisitorPassList.tsx`
- [ ] T148 [US3] Create VisitorPassDetails with QR display in `frontend/src/pages/resident/VisitorPassDetails.tsx`
- [ ] T149 [US3] Create QRCodeDisplay component in `frontend/src/components/common/QRCodeDisplay.tsx`
- [ ] T150 [US3] Create Resident dashboard in `frontend/src/pages/resident/Dashboard.tsx`

**Checkpoint**: Residents can create, view, and share visitor passes with QR codes.

---

## Phase 8: User Story 4 - Security Guard Manages Gate Access (Priority: P2)

**Goal**: Security verifies visitors, manages manual operations, monitors real-time activity

**Independent Test**: Login as security, verify visitor code, manual open gate, see live feed

### Backend Implementation

- [ ] T151 [US4] Implement PassVerificationService in `backend/src/modules/access/services/pass-verification.service.ts`
- [ ] T152 [US4] Implement ManualAccessService in `backend/src/modules/access/services/manual-access.service.ts`
- [ ] T153 [US4] Implement SecurityAccessController in `backend/src/modules/access/controllers/security-access.controller.ts`
- [ ] T154 [US4] Add pass verification endpoint to AccessModule

### Frontend Implementation

- [ ] T155 [P] [US4] Create SecurityLayout in `frontend/src/components/layouts/SecurityLayout.tsx`
- [ ] T156 [US4] Create security API service in `frontend/src/services/securityService.ts`
- [ ] T157 [US4] Create VerifyVisitorPass component in `frontend/src/components/security/VerifyVisitorPass.tsx`
- [ ] T158 [US4] Create ManualGateControl component in `frontend/src/components/security/ManualGateControl.tsx`
- [ ] T159 [US4] Create GateStatusCard component in `frontend/src/components/security/GateStatusCard.tsx`
- [ ] T160 [US4] Create SecurityDashboard page in `frontend/src/pages/security/Dashboard.tsx`
- [ ] T161 [US4] Integrate LiveEventFeed in SecurityDashboard in `frontend/src/pages/security/Dashboard.tsx`

**Checkpoint**: Security can verify passes, manually control gates, and see live activity.

---

## Phase 9: User Story 5 - RFID Access for Residents and Vehicles (Priority: P2)

**Goal**: Residents register RFID cards and vehicle tags, simulated detection opens gate

**Independent Test**: Register RFID, trigger detection in simulator, verify gate opens

### Backend Implementation

- [ ] T162 [P] [US5] Create RfidCard entity in `backend/src/database/entities/rfid-card.entity.ts`
- [ ] T163 [P] [US5] Create Vehicle entity in `backend/src/database/entities/vehicle.entity.ts`
- [ ] T164 [US5] Create rfid_cards table migration in `backend/src/database/migrations/013-create-rfid-cards.ts`
- [ ] T165 [US5] Create vehicles table migration in `backend/src/database/migrations/014-create-vehicles.ts`
- [ ] T166 [P] [US5] Create RFID DTOs in `backend/src/modules/access/dto/rfid.dto.ts`
- [ ] T167 [P] [US5] Create Vehicle DTOs in `backend/src/modules/access/dto/vehicle.dto.ts`
- [ ] T168 [US5] Implement RfidService in `backend/src/modules/access/services/rfid.service.ts`
- [ ] T169 [US5] Implement VehicleService in `backend/src/modules/access/services/vehicle.service.ts`
- [ ] T170 [US5] Implement RfidAccessService in `backend/src/modules/access/services/rfid-access.service.ts`
- [ ] T171 [US5] Implement RfidController in `backend/src/modules/access/controllers/rfid.controller.ts`
- [ ] T172 [US5] Implement VehicleController in `backend/src/modules/access/controllers/vehicle.controller.ts`
- [ ] T173 [US5] Connect RFID detection to simulator in `backend/src/modules/simulator/services/simulator.service.ts`

### Frontend Implementation

- [ ] T174 [P] [US5] Create RFID types in `frontend/src/types/rfid.ts`
- [ ] T175 [P] [US5] Create vehicle types in `frontend/src/types/vehicle.ts`
- [ ] T176 [US5] Create RFID API service in `frontend/src/services/rfidService.ts`
- [ ] T177 [US5] Create vehicle API service in `frontend/src/services/vehicleService.ts`
- [ ] T178 [US5] Create RegisterRfidCard form in `frontend/src/pages/resident/RegisterRfidCard.tsx`
- [ ] T179 [US5] Create RfidCardList page in `frontend/src/pages/resident/RfidCardList.tsx`
- [ ] T180 [US5] Create RegisterVehicle form in `frontend/src/pages/resident/RegisterVehicle.tsx`
- [ ] T181 [US5] Create VehicleList page in `frontend/src/pages/resident/VehicleList.tsx`

**Checkpoint**: RFID registration and simulated access working for humans and vehicles.

---

## Phase 10: User Story 6 - Resident Opens Gate via Web (Priority: P3)

**Goal**: Resident uses web dashboard to remotely open gate

**Independent Test**: Click "Open Gate" button, verify gate opens with App method logged

### Backend Implementation

- [ ] T182 [US6] Implement WebAccessService in `backend/src/modules/access/services/web-access.service.ts`
- [ ] T183 [US6] Add remote open endpoint to gate controller in `backend/src/modules/gates/controllers/gate.controller.ts`

### Frontend Implementation

- [ ] T184 [US6] Create RemoteGateOpen component in `frontend/src/components/resident/RemoteGateOpen.tsx`
- [ ] T185 [US6] Create GateSelectionModal component in `frontend/src/components/resident/GateSelectionModal.tsx`
- [ ] T186 [US6] Integrate RemoteGateOpen in Resident dashboard in `frontend/src/pages/resident/Dashboard.tsx`

**Checkpoint**: Residents can remotely open gates from web dashboard.

---

## Phase 11: User Story 7 - Staff Access with Schedule Rules (Priority: P3)

**Goal**: Building Admin registers staff with RFID and schedule, access enforced

**Independent Test**: Create staff with schedule, simulate RFID inside/outside schedule, verify access

### Backend Implementation

- [ ] T187 [US7] Implement ScheduleValidationService in `backend/src/modules/access/services/schedule-validation.service.ts`
- [ ] T188 [US7] Implement StaffService in `backend/src/modules/users/services/staff.service.ts`
- [ ] T189 [US7] Implement StaffController in `backend/src/modules/users/controllers/staff.controller.ts`
- [ ] T190 [US7] Integrate schedule validation in RfidAccessService in `backend/src/modules/access/services/rfid-access.service.ts`

### Frontend Implementation

- [ ] T191 [P] [US7] Create staff types in `frontend/src/types/staff.ts`
- [ ] T192 [US7] Create staff API service in `frontend/src/services/staffService.ts`
- [ ] T193 [US7] Create StaffList page in `frontend/src/pages/building-admin/StaffList.tsx`
- [ ] T194 [US7] Create CreateStaff form in `frontend/src/pages/building-admin/CreateStaff.tsx`
- [ ] T195 [US7] Create ScheduleEditor component in `frontend/src/components/common/ScheduleEditor.tsx`
- [ ] T196 [US7] Create StaffDetails page with schedule in `frontend/src/pages/building-admin/StaffDetails.tsx`

**Checkpoint**: Staff access with schedule enforcement working.

---

## Phase 12: User Story 10 - Building Policy Configuration (Priority: P3)

**Goal**: Building Admin configures access policies affecting all operations

**Independent Test**: Modify policy setting, verify it affects subsequent access decisions

### Backend Implementation

- [ ] T197 [P] [US10] Create AccessPolicy entity in `backend/src/database/entities/access-policy.entity.ts`
- [ ] T198 [US10] Create access_policies table migration in `backend/src/database/migrations/015-create-access-policies.ts`
- [ ] T199 [P] [US10] Create Policy DTOs in `backend/src/modules/policies/dto/policy.dto.ts`
- [ ] T200 [US10] Implement PoliciesModule structure in `backend/src/modules/policies/policies.module.ts`
- [ ] T201 [US10] Implement PolicyService in `backend/src/modules/policies/services/policy.service.ts`
- [ ] T202 [US10] Implement PolicyEnforcementService in `backend/src/modules/policies/services/policy-enforcement.service.ts`
- [ ] T203 [US10] Implement PolicyController in `backend/src/modules/policies/controllers/policy.controller.ts`
- [ ] T204 [US10] Integrate policy enforcement in access services in `backend/src/modules/access/`

### Frontend Implementation

- [ ] T205 [P] [US10] Create policy types in `frontend/src/types/policy.ts`
- [ ] T206 [US10] Create policy API service in `frontend/src/services/policyService.ts`
- [ ] T207 [US10] Create PolicyConfigPage in `frontend/src/pages/building-admin/PolicyConfig.tsx`
- [ ] T208 [US10] Create VisitorPassPolicyForm component in `frontend/src/components/policies/VisitorPassPolicyForm.tsx`
- [ ] T209 [US10] Create SensorPolicyForm component in `frontend/src/components/policies/SensorPolicyForm.tsx`
- [ ] T210 [US10] Create StaffSchedulePolicyForm component in `frontend/src/components/policies/StaffSchedulePolicyForm.tsx`

**Checkpoint**: All policy configurations working and enforced.

---

## Phase 13: Polish & Cross-Cutting Concerns

**Purpose**: Final improvements affecting multiple user stories

### Navigation & UX

- [ ] T211 [P] Create main navigation sidebar in `frontend/src/components/common/Sidebar.tsx`
- [ ] T212 [P] Create responsive mobile menu in `frontend/src/components/common/MobileMenu.tsx`
- [ ] T213 [P] Create breadcrumb component in `frontend/src/components/common/Breadcrumb.tsx`
- [ ] T214 Add loading states to all pages in `frontend/src/components/common/LoadingSpinner.tsx`
- [ ] T215 Add error boundary component in `frontend/src/components/common/ErrorBoundary.tsx`

### Security Hardening

- [ ] T216 Implement rate limiting middleware in `backend/src/common/middleware/rate-limit.middleware.ts`
- [ ] T217 Add CORS configuration in `backend/src/main.ts`
- [ ] T218 Implement request validation for all DTOs in `backend/src/modules/`
- [ ] T219 Add audit logging for sensitive operations in `backend/src/common/interceptors/audit.interceptor.ts`

### Performance

- [ ] T220 Add database indexes optimization migration in `backend/src/database/migrations/016-add-indexes.ts`
- [ ] T221 Implement pagination for all list endpoints in `backend/src/common/dto/pagination.dto.ts`
- [ ] T222 Add caching for tenant configuration in `backend/src/common/services/cache.service.ts`

### Documentation & Deployment

- [ ] T223 Create API documentation with examples in `backend/src/main.ts` Swagger config
- [ ] T224 Create deployment documentation in `docs/deployment.md`
- [ ] T225 Create .env.production templates for backend and frontend
- [ ] T226 Validate quickstart.md flow works end-to-end

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - US1 and US2 are both P1 and can run in parallel after Foundation
  - US8 (Simulator) should complete before testing US3-US7
  - US9 (Events) can run parallel to US8
  - US3-US7 depend on having working simulator and events
  - US10 (Policies) depends on US3-US7 for enforcement integration
- **Polish (Phase 13)**: Depends on all user stories being complete

### User Story Dependencies

| Story | Priority | Depends On | Can Start After |
|-------|----------|------------|-----------------|
| US1 | P1 | Foundation only | Phase 2 complete |
| US2 | P1 | Foundation only | Phase 2 complete |
| US8 | P2 | US2 (gates) | Phase 4 complete |
| US9 | P2 | Foundation only | Phase 2 complete |
| US3 | P2 | US8 (for testing) | Phase 5 complete |
| US4 | P2 | US3, US9 | Phase 6, 7 complete |
| US5 | P2 | US8 (for testing) | Phase 5 complete |
| US6 | P3 | US2 (gates) | Phase 4 complete |
| US7 | P3 | US5 (RFID) | Phase 9 complete |
| US10 | P3 | US3-US7 | Phase 9 complete |

### Parallel Opportunities

**Phase 1 (Setup)**:
- T003, T004, T005, T006, T007, T008, T009 can all run in parallel

**Phase 2 (Foundational)**:
- T014, T016, T017 can run in parallel (different entities)
- T024, T025, T26, T027 can run in parallel (different guards/decorators)
- T044, T045, T046, T047 can run in parallel (different frontend files)

**User Story Phases**:
- Within each story, tasks marked [P] can run in parallel
- Different stories can be worked on by different team members after Foundation

---

## Parallel Example: Phase 2 Foundation

```bash
# Launch database entities in parallel:
Task: "Create User entity in backend/src/database/entities/user.entity.ts"
Task: "Create RefreshToken entity in backend/src/database/entities/refresh-token.entity.ts"
Task: "Create SubscriptionPlan entity in backend/src/database/entities/subscription-plan.entity.ts"
Task: "Create Tenant entity in backend/src/database/entities/tenant.entity.ts"

# Launch frontend contexts in parallel:
Task: "Create AuthContext in frontend/src/contexts/AuthContext.tsx"
Task: "Create TenantContext in frontend/src/contexts/TenantContext.tsx"
Task: "Create API client service in frontend/src/services/api.ts"
Task: "Create WebSocket service in frontend/src/services/websocket.ts"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 (Super Admin + Tenants)
4. Complete Phase 4: User Story 2 (Gates + Health)
5. **STOP and VALIDATE**: Test US1 and US2 independently
6. Deploy/demo if ready - Basic multi-tenant with gates

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 + US2 → Test independently → Deploy (MVP!)
3. Add US8 (Simulator) → Test gate operations
4. Add US9 (Events) → Test logging and dashboards
5. Add US3 (Visitor Pass) → Test visitor flow
6. Add US4 (Security) → Test security operations
7. Add US5 (RFID) → Test RFID access
8. Add US6, US7, US10 (P3 features) → Complete feature set
9. Polish phase → Production-ready

### Parallel Team Strategy

With 3 developers:

1. All complete Setup + Foundational together
2. Once Foundation done:
   - Developer A: US1 → US3 → US6
   - Developer B: US2 → US8 → US4
   - Developer C: US9 → US5 → US7 → US10
3. All complete Polish together

---

## Summary

| Phase | Tasks | User Story | Priority |
|-------|-------|------------|----------|
| 1 | 11 | Setup | - |
| 2 | 43 | Foundational | BLOCKING |
| 3 | 22 | US1: Super Admin Onboards Building | P1 |
| 4 | 30 | US2: Gates and Device Health | P1 |
| 5 | 12 | US8: Gate Simulator | P2 |
| 6 | 17 | US9: Event Logging | P2 |
| 7 | 15 | US3: Visitor Pass | P2 |
| 8 | 11 | US4: Security Guard | P2 |
| 9 | 20 | US5: RFID Access | P2 |
| 10 | 5 | US6: Web Remote Open | P3 |
| 11 | 10 | US7: Staff Schedules | P3 |
| 12 | 14 | US10: Policies | P3 |
| 13 | 16 | Polish | - |
| **Total** | **226** | | |

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Tests not included - add with `/speckit.tasks --tdd` if needed
