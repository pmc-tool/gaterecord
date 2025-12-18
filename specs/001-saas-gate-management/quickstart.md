# Quickstart Guide: SaaS Gate Management System

**Feature**: 001-saas-gate-management
**Date**: 2025-12-17

## Prerequisites

- Node.js 20 LTS
- PostgreSQL 16
- pnpm (recommended) or npm
- Git

## Project Setup

### 1. Clone and Install

```bash
# Clone repository
git clone <repo-url>
cd Gate

# Install dependencies
pnpm install
```

### 2. Environment Configuration

Create `.env` files for backend and frontend:

**backend/.env**
```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/gate_management
DATABASE_SSL=false

# JWT
JWT_SECRET=your-super-secret-key-change-in-production
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d

# CORS
CORS_ORIGIN=http://localhost:5173

# Logging
LOG_LEVEL=debug
```

**frontend/.env**
```env
VITE_API_URL=http://localhost:3000/api/v1
VITE_WS_URL=http://localhost:3000
```

### 3. Database Setup

```bash
# Create database
createdb gate_management

# Run migrations
cd backend
pnpm migration:run

# Seed initial data (Super Admin + sample tenant)
pnpm seed
```

### 4. Start Development Servers

```bash
# Terminal 1: Backend
cd backend
pnpm start:dev

# Terminal 2: Frontend
cd frontend
pnpm dev
```

### 5. Access Application

- **Frontend**: http://localhost:5173
- **API**: http://localhost:3000/api/v1
- **API Docs**: http://localhost:3000/api/docs (Swagger)

## Default Credentials (After Seeding)

| Role | Email | Password |
|------|-------|----------|
| Super Admin | admin@gatemanagement.com | Admin123! |
| Building Admin | admin@building1.com | Building123! |
| Security | security@building1.com | Security123! |
| Resident | resident@building1.com | Resident123! |

## Quick Test Flow

### 1. Login as Super Admin

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@gatemanagement.com", "password": "Admin123!"}'
```

### 2. Create a Subscription Plan

```bash
curl -X POST http://localhost:3000/api/v1/admin/plans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "name": "Basic",
    "maxGates": 3,
    "maxUsers": 50,
    "logRetentionDays": 30,
    "features": {"simulator_access": true, "csv_export": true}
  }'
```

### 3. Onboard a Building

```bash
curl -X POST http://localhost:3000/api/v1/admin/tenants \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "name": "Sunrise Apartments",
    "slug": "sunrise-apartments",
    "contactEmail": "contact@sunrise.com",
    "subscriptionPlanId": "<plan-id>",
    "adminEmail": "admin@sunrise.com",
    "adminFirstName": "John",
    "adminLastName": "Doe"
  }'
```

### 4. Login as Building Admin & Create Gate

```bash
# Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@sunrise.com", "password": "<temp-password>"}'

# Create Gate
curl -X POST http://localhost:3000/api/v1/gates \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "name": "Main Entry",
    "type": "vehicle",
    "location": "Front Gate"
  }'
```

### 5. Test Gate Simulator

```bash
# Trigger RFID detection
curl -X POST http://localhost:3000/api/v1/simulator/<gateId>/trigger \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "event": "car_rfid_detected",
    "rfidUid": "ABCD1234"
  }'
```

## Project Structure

```
Gate/
├── backend/
│   ├── src/
│   │   ├── modules/          # Feature modules
│   │   ├── common/           # Shared utilities
│   │   ├── database/         # Entities, migrations
│   │   └── gateway/          # WebSocket
│   ├── test/
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/       # UI components
│   │   ├── pages/            # Role-based pages
│   │   ├── services/         # API clients
│   │   └── hooks/            # Custom hooks
│   └── package.json
└── specs/
    └── 001-saas-gate-management/
        ├── spec.md           # Feature spec
        ├── plan.md           # Implementation plan
        ├── research.md       # Tech decisions
        ├── data-model.md     # Database schema
        ├── quickstart.md     # This file
        └── contracts/        # API contracts
```

## Common Commands

### Backend

```bash
# Development server with watch
pnpm start:dev

# Run tests
pnpm test

# Run tests with coverage
pnpm test:cov

# Run e2e tests
pnpm test:e2e

# Generate migration
pnpm migration:generate -- ./src/database/migrations/MigrationName

# Run migrations
pnpm migration:run

# Revert last migration
pnpm migration:revert

# Lint
pnpm lint

# Build for production
pnpm build
```

### Frontend

```bash
# Development server
pnpm dev

# Run tests
pnpm test

# Build for production
pnpm build

# Preview production build
pnpm preview

# Lint
pnpm lint
```

## Key Concepts

### Multi-Tenancy

- Every request includes tenant context via JWT
- PostgreSQL Row-Level Security (RLS) enforces isolation
- Super Admin can access all tenants

### Gate State Machine

```
CLOSED → OPENING → OPEN → CLOSING → CLOSED
              ↓           ↓
         OBSTACLE_HOLD ←──┘
              ↓
           FAULT
              ↓
       MANUAL_OVERRIDE
```

### Access Methods

1. **Car RFID**: Vehicle tag detected
2. **Human RFID**: Personal card detected
3. **QR**: Visitor pass scanned
4. **Web App**: Resident remote open
5. **Manual**: Security guard override

### Real-Time Updates

- Connect via Socket.io to receive live events
- Join `gate:{gateId}` room for specific gate updates
- Events: `gate:state-change`, `access:event`, `health:update`

## Troubleshooting

### Database Connection Issues

```bash
# Check PostgreSQL is running
pg_isready

# Check connection
psql -U postgres -d gate_management -c "SELECT 1"
```

### CORS Errors

Ensure `CORS_ORIGIN` in backend `.env` matches frontend URL.

### JWT Issues

- Check `JWT_SECRET` is set
- Verify token hasn't expired
- Ensure token is in `Authorization: Bearer <token>` format

### WebSocket Connection

- Check `VITE_WS_URL` points to backend
- Ensure auth token is passed in connection

## Next Steps

1. Review [spec.md](./spec.md) for full requirements
2. Review [data-model.md](./data-model.md) for database schema
3. Review [contracts/openapi.yaml](./contracts/openapi.yaml) for API details
4. Review [contracts/websocket.md](./contracts/websocket.md) for real-time events
