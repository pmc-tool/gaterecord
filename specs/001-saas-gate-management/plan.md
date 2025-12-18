# Implementation Plan: SaaS Gate Management System

**Branch**: `001-saas-gate-management` | **Date**: 2025-12-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-saas-gate-management/spec.md`

## Summary

Build a multi-tenant SaaS platform for residential building gate access management. Phase-1 delivers a complete web application with simulation mode (no hardware), designed for Phase-2 ESP32 integration. The system manages residents, staff, visitors (QR passes), vehicles (RFID), gates, and provides comprehensive event logging with real-time dashboards.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js 20 LTS)
**Primary Dependencies**:
- Backend: NestJS 10.x, TypeORM, Socket.io, Passport.js
- Frontend: React 18.x, Ant Design 5.x, Tailwind CSS 3.x, Socket.io-client
**Storage**: PostgreSQL 16 with Row-Level Security (RLS) for multi-tenancy
**Testing**: Jest (backend), React Testing Library + Vitest (frontend)
**Target Platform**: Web (responsive), Linux server deployment
**Project Type**: Web application (backend + frontend)
**Performance Goals**: 100 concurrent users per building, <2s real-time updates, <10s access verification
**Constraints**: Multi-tenant data isolation, JWT auth with refresh tokens, WebSocket for real-time
**Scale/Scope**: 10+ buildings, 1-10 gates per building, 100+ users per building

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| Constitution not yet defined | N/A | Project uses default best practices |

**Pre-Phase 0 Status**: PASS (no constitution violations - constitution not yet customized)

## Project Structure

### Documentation (this feature)

```text
specs/001-saas-gate-management/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output - technology decisions
├── data-model.md        # Phase 1 output - database schema
├── quickstart.md        # Phase 1 output - setup guide
├── contracts/           # Phase 1 output - API contracts
│   ├── openapi.yaml     # REST API specification
│   └── websocket.md     # WebSocket events specification
├── checklists/          # Quality checklists
│   └── requirements.md  # Spec validation checklist
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── modules/
│   │   ├── auth/           # Authentication & authorization
│   │   ├── tenants/        # Multi-tenant management
│   │   ├── users/          # User & role management
│   │   ├── gates/          # Gate management & state machine
│   │   ├── access/         # Access methods (RFID, QR, Web, Manual)
│   │   ├── events/         # Event logging & queries
│   │   ├── simulator/      # Gate simulator logic
│   │   ├── health/         # Device & sensor health
│   │   └── policies/       # Access policies
│   ├── common/
│   │   ├── guards/         # Auth guards, tenant guards
│   │   ├── decorators/     # Custom decorators
│   │   ├── filters/        # Exception filters
│   │   └── interceptors/   # Logging, transform interceptors
│   ├── database/
│   │   ├── entities/       # TypeORM entities
│   │   ├── migrations/     # Database migrations
│   │   └── seeds/          # Seed data
│   └── gateway/            # WebSocket gateway for real-time
├── test/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── package.json
├── nest-cli.json
└── tsconfig.json

frontend/
├── src/
│   ├── components/
│   │   ├── common/         # Shared UI components
│   │   ├── gates/          # Gate-related components
│   │   ├── simulator/      # Gate simulator UI
│   │   ├── health/         # Device health components
│   │   └── events/         # Event feed components
│   ├── pages/
│   │   ├── super-admin/    # Super admin pages
│   │   ├── building-admin/ # Building admin pages
│   │   ├── security/       # Security guard pages
│   │   └── resident/       # Resident pages
│   ├── services/           # API client services
│   ├── hooks/              # Custom React hooks
│   ├── contexts/           # React contexts (auth, tenant)
│   ├── utils/              # Utility functions
│   └── types/              # TypeScript types
├── tests/
├── package.json
├── vite.config.ts
└── tailwind.config.js
```

**Structure Decision**: Web application structure with separate `backend/` and `frontend/` directories. NestJS modular architecture for backend with feature-based modules. React with feature-based page organization for role-based dashboards.

## Complexity Tracking

> No constitution violations to justify - using standard web application patterns.

| Decision | Rationale |
|----------|-----------|
| Separate backend/frontend | Standard for React + NestJS, enables independent deployment |
| PostgreSQL RLS | Industry standard for multi-tenant data isolation |
| WebSocket for real-time | Required for <2s gate state updates (SC-005) |
| TypeORM | Mature ORM with migration support, works well with NestJS |
