# Research: SaaS Gate Management System

**Feature**: 001-saas-gate-management
**Date**: 2025-12-17
**Status**: Complete

## Technology Decisions

### 1. Backend Framework: NestJS

**Decision**: NestJS 10.x with TypeScript

**Rationale**:
- Modular architecture fits multi-tenant SaaS design
- Built-in support for WebSockets (Socket.io integration)
- Excellent TypeORM integration for PostgreSQL
- Guards and interceptors for tenant isolation
- Strong typing with TypeScript
- Active community and enterprise adoption

**Alternatives Considered**:
- Express.js: Too minimal, requires too much boilerplate for complex RBAC
- Fastify: Good performance but less mature ecosystem for real-time features
- Koa: Similar to Express concerns

### 2. Database: PostgreSQL with Row-Level Security

**Decision**: PostgreSQL 16 with RLS for multi-tenant isolation

**Rationale**:
- Row-Level Security (RLS) provides database-level tenant isolation
- Strong ACID compliance for access event logging
- JSON/JSONB support for flexible policy storage
- Excellent performance for complex queries (event filtering)
- Mature ecosystem with TypeORM support

**Multi-Tenancy Pattern**:
```sql
-- All tenant tables include tenant_id
-- RLS policies automatically filter by current tenant
ALTER TABLE gates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gates
  USING (tenant_id = current_setting('app.current_tenant')::uuid);
```

**Alternatives Considered**:
- MySQL: Lacks native RLS, would require application-level isolation
- MongoDB: Eventual consistency issues for access control audit
- Supabase: Good but adds vendor lock-in

### 3. Frontend Framework: React + Ant Design + Tailwind

**Decision**: React 18.x with Ant Design 5.x and Tailwind CSS 3.x

**Rationale**:
- React: Industry standard, large ecosystem, good for complex dashboards
- Ant Design: Enterprise-grade components (tables, forms, charts) out of box
- Tailwind: Utility-first CSS for custom styling alongside Ant Design
- Vite: Fast build tooling for development

**Component Strategy**:
- Use Ant Design for complex components (Table, Form, Modal, DatePicker)
- Use Tailwind for layout and custom styling
- Create shared component library in `components/common/`

**Alternatives Considered**:
- Vue.js + Vuetify: Smaller ecosystem for enterprise dashboards
- Angular + Material: Steeper learning curve, heavier bundle
- Next.js: SSR not required for this dashboard application

### 4. Real-Time Communication: Socket.io

**Decision**: Socket.io for WebSocket-based real-time updates

**Rationale**:
- Automatic fallback to long-polling if WebSocket unavailable
- Room-based broadcasting (per tenant, per gate)
- Built-in reconnection handling
- Native NestJS integration via @nestjs/websockets

**Event Architecture**:
```typescript
// Server emits to tenant room
socket.to(`tenant:${tenantId}`).emit('gate:state-change', payload);

// Server emits to specific gate room
socket.to(`gate:${gateId}`).emit('access:event', payload);
```

**Alternatives Considered**:
- Raw WebSocket: Lacks fallback and room management
- Server-Sent Events: Unidirectional, can't handle gate commands
- Polling: Too slow for <2s requirement

### 5. Authentication: JWT with Refresh Tokens

**Decision**: JWT access tokens (15min) + refresh tokens (7 days)

**Rationale**:
- Stateless authentication scales horizontally
- Short-lived access tokens minimize security risk
- Refresh tokens enable seamless UX
- Multi-tenant claims in JWT payload

**JWT Payload Structure**:
```typescript
{
  sub: "user-uuid",
  tenantId: "tenant-uuid",
  role: "BUILDING_ADMIN",
  permissions: ["gates:read", "gates:write"],
  iat: 1234567890,
  exp: 1234568790
}
```

**Alternatives Considered**:
- Session-based: Requires sticky sessions, harder to scale
- OAuth2 with external provider: Overkill for Phase-1, adds complexity

### 6. State Machine: XState-inspired Pattern

**Decision**: Custom state machine implementation for gate states

**Rationale**:
- Gate has 7 defined states with specific transitions
- State machine ensures valid transitions only
- Easy to test and visualize
- Lightweight (no external library needed for simple FSM)

**State Machine Definition**:
```typescript
enum GateState {
  CLOSED = 'CLOSED',
  OPENING = 'OPENING',
  OPEN = 'OPEN',
  CLOSING = 'CLOSING',
  OBSTACLE_HOLD = 'OBSTACLE_HOLD',
  FAULT = 'FAULT',
  MANUAL_OVERRIDE = 'MANUAL_OVERRIDE'
}

const transitions = {
  CLOSED: ['OPENING', 'MANUAL_OVERRIDE', 'FAULT'],
  OPENING: ['OPEN', 'OBSTACLE_HOLD', 'FAULT', 'MANUAL_OVERRIDE'],
  OPEN: ['CLOSING', 'OBSTACLE_HOLD', 'MANUAL_OVERRIDE', 'FAULT'],
  CLOSING: ['CLOSED', 'OBSTACLE_HOLD', 'FAULT', 'MANUAL_OVERRIDE'],
  OBSTACLE_HOLD: ['CLOSING', 'MANUAL_OVERRIDE', 'FAULT'],
  FAULT: ['MANUAL_OVERRIDE', 'CLOSED'],
  MANUAL_OVERRIDE: ['CLOSED', 'OPEN', 'FAULT']
};
```

**Alternatives Considered**:
- XState library: Overkill for 7-state machine
- Database triggers: Harder to test, less visible

### 7. QR Code Generation

**Decision**: Server-side QR generation with `qrcode` npm package

**Rationale**:
- Generate QR on visitor pass creation
- Store as base64 or serve as image endpoint
- Include signed token in QR data for validation
- Works offline once generated

**QR Token Structure**:
```typescript
{
  passId: "pass-uuid",
  tenantId: "tenant-uuid",
  gateIds: ["gate-1", "gate-2"],  // Authorized gates
  validFrom: "2025-12-17T10:00:00Z",
  validUntil: "2025-12-17T14:00:00Z",
  maxEntries: 2,
  signature: "hmac-signature"
}
```

### 8. CSV Export

**Decision**: Server-side CSV generation with streaming

**Rationale**:
- Handle large datasets (10,000+ events)
- Stream response to avoid memory issues
- Use `fast-csv` or `json2csv` library

**Alternatives Considered**:
- Client-side generation: Memory issues with large datasets
- Excel export: More complex, CSV sufficient for Phase-1

### 9. Phase-2 Hardware Communication: MQTT

**Decision**: MQTT protocol for ESP32 communication (Phase-2)

**Rationale**:
- Lightweight protocol designed for IoT
- Bi-directional communication
- QoS levels for reliable delivery
- Handles offline/reconnect gracefully
- Low bandwidth overhead

**Topic Structure** (designed now, implemented Phase-2):
```
gate/{gateId}/status     # Gate publishes state
gate/{gateId}/command    # Server publishes commands
gate/{gateId}/events     # Gate publishes access events
gate/{gateId}/health     # Gate publishes sensor health
```

**Alternatives Considered**:
- HTTP polling: High overhead, not real-time
- WebSocket: More complex for ESP32, no native support
- CoAP: Less tooling available

### 10. Testing Strategy

**Decision**: Multi-layer testing approach

**Backend Testing**:
- Unit tests: Jest for service/controller logic
- Integration tests: Supertest for API endpoints
- E2E tests: Full flow testing with test database

**Frontend Testing**:
- Unit tests: Vitest + React Testing Library
- Component tests: Storybook for visual testing
- E2E tests: Playwright for critical flows

**Test Database**: Separate PostgreSQL instance with seeded data

## Resolved Clarifications

| Original Unknown | Resolution | Source |
|------------------|------------|--------|
| Backend framework | NestJS | User choice + research |
| Database | PostgreSQL | User choice |
| Frontend framework | React + Ant Design + Tailwind | User choice |
| Real-time approach | Socket.io | Best practice for NestJS |
| Auth method | JWT with refresh tokens | Standard for SaaS |
| IoT protocol | MQTT | User choice + research |
| Multi-tenancy pattern | RLS in PostgreSQL | Best practice |

## Dependencies Summary

### Backend Dependencies

```json
{
  "dependencies": {
    "@nestjs/common": "^10.0.0",
    "@nestjs/core": "^10.0.0",
    "@nestjs/platform-express": "^10.0.0",
    "@nestjs/typeorm": "^10.0.0",
    "@nestjs/websockets": "^10.0.0",
    "@nestjs/platform-socket.io": "^10.0.0",
    "@nestjs/passport": "^10.0.0",
    "@nestjs/jwt": "^10.0.0",
    "typeorm": "^0.3.0",
    "pg": "^8.0.0",
    "passport": "^0.7.0",
    "passport-jwt": "^4.0.0",
    "bcrypt": "^5.0.0",
    "class-validator": "^0.14.0",
    "class-transformer": "^0.5.0",
    "qrcode": "^1.5.0",
    "fast-csv": "^5.0.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@nestjs/testing": "^10.0.0",
    "jest": "^29.0.0",
    "supertest": "^6.0.0",
    "typescript": "^5.0.0"
  }
}
```

### Frontend Dependencies

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.0.0",
    "antd": "^5.0.0",
    "tailwindcss": "^3.0.0",
    "@ant-design/icons": "^5.0.0",
    "socket.io-client": "^4.0.0",
    "axios": "^1.0.0",
    "zustand": "^4.0.0",
    "dayjs": "^1.11.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^5.0.0",
    "vitest": "^1.0.0",
    "@testing-library/react": "^14.0.0",
    "typescript": "^5.0.0"
  }
}
```

## Performance Considerations

### Database Indexing Strategy

```sql
-- Tenant isolation index (all tenant tables)
CREATE INDEX idx_gates_tenant ON gates(tenant_id);
CREATE INDEX idx_users_tenant ON users(tenant_id);

-- Access events query optimization
CREATE INDEX idx_events_tenant_gate_timestamp
  ON access_events(tenant_id, gate_id, timestamp DESC);
CREATE INDEX idx_events_method ON access_events(method);
CREATE INDEX idx_events_result ON access_events(result);

-- RFID lookup optimization
CREATE INDEX idx_rfid_cards_uid ON rfid_cards(uid);
CREATE INDEX idx_vehicles_rfid ON vehicles(rfid_uid);
```

### Connection Pooling

- PostgreSQL: pgBouncer or TypeORM pool (max 20 connections)
- Socket.io: Redis adapter for horizontal scaling (Phase-2+)

### Caching Strategy (Phase-1)

- JWT validation: In-memory cache for public keys
- Tenant config: In-memory cache with 5-min TTL
- No Redis required for Phase-1 scale
