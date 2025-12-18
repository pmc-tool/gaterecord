# WebSocket Events Specification

**Feature**: 001-saas-gate-management
**Protocol**: Socket.io
**Server**: NestJS WebSocket Gateway

## Connection

### Authentication

WebSocket connections require JWT authentication via handshake query parameter.

```typescript
// Client connection
const socket = io('ws://localhost:3000', {
  auth: {
    token: 'jwt-access-token'
  }
});
```

### Rooms

Clients automatically join rooms based on their tenant and role:

| Room Pattern | Description | Who Joins |
|--------------|-------------|-----------|
| `tenant:{tenantId}` | All events for a tenant | All authenticated users |
| `gate:{gateId}` | Events for specific gate | Users viewing that gate |
| `admin` | Super admin events | Super admin only |

## Events

### Server → Client Events

#### `gate:state-change`

Emitted when a gate's state changes.

```typescript
interface GateStateChangeEvent {
  gateId: string;
  gateName: string;
  previousState: GateState;
  newState: GateState;
  timestamp: string; // ISO 8601
  trigger: 'access' | 'timeout' | 'sensor' | 'manual' | 'fault';
}

// Example
{
  "gateId": "uuid",
  "gateName": "Main Entry",
  "previousState": "CLOSED",
  "newState": "OPENING",
  "timestamp": "2025-12-17T10:30:00Z",
  "trigger": "access"
}
```

**Room**: `tenant:{tenantId}`, `gate:{gateId}`

---

#### `access:event`

Emitted when an access attempt occurs (allowed or denied).

```typescript
interface AccessEventNotification {
  eventId: string;
  gateId: string;
  gateName: string;
  timestamp: string;
  method: 'car_rfid' | 'human_rfid' | 'qr' | 'web_app' | 'manual';
  subjectType: 'vehicle' | 'rfid_card' | 'visitor_pass' | 'user' | 'unknown';
  subjectName: string; // Display name
  result: 'allowed' | 'denied';
  denialReason?: string;
  operatorName?: string; // For manual access
}

// Example
{
  "eventId": "uuid",
  "gateId": "uuid",
  "gateName": "Main Entry",
  "timestamp": "2025-12-17T10:30:00Z",
  "method": "qr",
  "subjectType": "visitor_pass",
  "subjectName": "John Doe (Visitor)",
  "result": "allowed"
}
```

**Room**: `tenant:{tenantId}`, `gate:{gateId}`

---

#### `health:update`

Emitted when sensor/controller health status changes.

```typescript
interface HealthUpdateEvent {
  gateId: string;
  gateName: string;
  type: 'controller' | 'sensor';
  sensorType?: SensorType;
  previousStatus: SensorHealthStatus;
  newStatus: SensorHealthStatus;
  timestamp: string;
  notes?: string;
}

// Example - Controller offline
{
  "gateId": "uuid",
  "gateName": "Main Entry",
  "type": "controller",
  "previousStatus": "online",
  "newStatus": "offline",
  "timestamp": "2025-12-17T10:30:00Z"
}

// Example - Sensor missing
{
  "gateId": "uuid",
  "gateName": "Main Entry",
  "type": "sensor",
  "sensorType": "ir_obstacle",
  "previousStatus": "ok",
  "newStatus": "missing",
  "timestamp": "2025-12-17T10:30:00Z",
  "notes": "Check wiring"
}
```

**Room**: `tenant:{tenantId}`, `gate:{gateId}`

---

#### `health:heartbeat`

Emitted periodically when controller heartbeat received (Phase-2 mainly, simulated in Phase-1).

```typescript
interface HeartbeatEvent {
  gateId: string;
  controllerId: string;
  firmwareVersion: string;
  uptimeSeconds: number;
  wifiStrength: number;
  sensorsOk: number;
  sensorsTotal: number;
  timestamp: string;
}
```

**Room**: `gate:{gateId}`

---

#### `simulator:feedback`

Emitted in response to simulator actions (Phase-1 only).

```typescript
interface SimulatorFeedbackEvent {
  gateId: string;
  action: string;
  success: boolean;
  message: string;
  gateState: GateState;
  eventId?: string;
}

// Example
{
  "gateId": "uuid",
  "action": "car_rfid_detected",
  "success": true,
  "message": "Access granted - Vehicle recognized",
  "gateState": "OPENING",
  "eventId": "uuid"
}
```

**Room**: `gate:{gateId}`

---

#### `tenant:subscription-warning`

Emitted when subscription is about to expire.

```typescript
interface SubscriptionWarningEvent {
  tenantId: string;
  daysRemaining: number;
  expiresAt: string;
  message: string;
}
```

**Room**: `tenant:{tenantId}`

---

### Client → Server Events

#### `join:gate`

Client requests to join a specific gate's room for detailed updates.

```typescript
// Client emits
socket.emit('join:gate', { gateId: 'uuid' });

// Server acknowledges
socket.on('joined:gate', (data) => {
  console.log(`Joined gate ${data.gateId}`);
});
```

---

#### `leave:gate`

Client leaves a gate's room.

```typescript
socket.emit('leave:gate', { gateId: 'uuid' });
```

---

#### `simulator:trigger` (Phase-1)

Client triggers a simulated event directly via WebSocket (alternative to REST).

```typescript
interface SimulatorTriggerPayload {
  gateId: string;
  event: 'car_rfid_detected' | 'human_rfid_detected' | 'qr_verified' |
         'obstacle_detected' | 'obstacle_cleared' | 'limit_open_reached' |
         'limit_close_reached' | 'manual_open' | 'manual_close';
  rfidUid?: string;
  qrToken?: string;
}

// Client emits
socket.emit('simulator:trigger', {
  gateId: 'uuid',
  event: 'car_rfid_detected',
  rfidUid: 'ABCD1234'
});

// Server responds via simulator:feedback event
```

---

## Error Events

#### `error`

Emitted when an error occurs during WebSocket operation.

```typescript
interface ErrorEvent {
  code: string;
  message: string;
  details?: object;
}

// Error codes
// AUTH_FAILED - Authentication failed
// PERMISSION_DENIED - No access to requested resource
// GATE_NOT_FOUND - Gate doesn't exist or not in tenant
// INVALID_PAYLOAD - Invalid event payload
// RATE_LIMITED - Too many requests
```

---

## Connection Lifecycle

```
Client                                Server
  |                                     |
  |-- connect (with JWT auth) --------->|
  |                                     | Validate JWT
  |                                     | Join tenant:{tenantId} room
  |<--- connected -----------------------|
  |                                     |
  |-- join:gate {gateId} -------------->|
  |                                     | Validate access
  |<--- joined:gate {gateId} ------------|
  |                                     |
  |<--- gate:state-change ---------------|  (when gate state changes)
  |<--- access:event --------------------|  (when access attempt)
  |<--- health:update -------------------|  (when health changes)
  |                                     |
  |-- simulator:trigger ---------------->|  (Phase-1 simulator)
  |<--- simulator:feedback --------------|
  |                                     |
  |-- leave:gate {gateId} -------------->|
  |-- disconnect ----------------------->|
```

---

## Rate Limiting

| Event | Limit | Window |
|-------|-------|--------|
| `simulator:trigger` | 10 | per second |
| `join:gate` | 5 | per second |

---

## TypeScript Types

```typescript
// Enums
type GateState =
  | 'CLOSED'
  | 'OPENING'
  | 'OPEN'
  | 'CLOSING'
  | 'OBSTACLE_HOLD'
  | 'FAULT'
  | 'MANUAL_OVERRIDE';

type SensorType =
  | 'esp32_controller'
  | 'rfid_reader'
  | 'ir_obstacle'
  | 'ultrasonic'
  | 'limit_switch_open'
  | 'limit_switch_close'
  | 'servo_actuator'
  | 'oled_display'
  | 'led_buzzer';

type SensorHealthStatus =
  | 'ok'
  | 'abnormal'
  | 'missing'
  | 'offline'
  | 'unknown';

type AccessMethod =
  | 'car_rfid'
  | 'human_rfid'
  | 'qr'
  | 'web_app'
  | 'manual';

type AccessResult = 'allowed' | 'denied';

type SimulatorEvent =
  | 'car_rfid_detected'
  | 'human_rfid_detected'
  | 'qr_verified'
  | 'obstacle_detected'
  | 'obstacle_cleared'
  | 'limit_open_reached'
  | 'limit_close_reached'
  | 'manual_open'
  | 'manual_close';
```

---

## Frontend Integration Example

```typescript
import { io, Socket } from 'socket.io-client';

class GateSocket {
  private socket: Socket;

  constructor(token: string) {
    this.socket = io(process.env.WS_URL, {
      auth: { token }
    });

    this.socket.on('connect', () => {
      console.log('Connected to gate management');
    });

    this.socket.on('error', (error) => {
      console.error('Socket error:', error);
    });
  }

  // Join specific gate room
  joinGate(gateId: string): void {
    this.socket.emit('join:gate', { gateId });
  }

  // Listen for state changes
  onGateStateChange(callback: (event: GateStateChangeEvent) => void): void {
    this.socket.on('gate:state-change', callback);
  }

  // Listen for access events
  onAccessEvent(callback: (event: AccessEventNotification) => void): void {
    this.socket.on('access:event', callback);
  }

  // Listen for health updates
  onHealthUpdate(callback: (event: HealthUpdateEvent) => void): void {
    this.socket.on('health:update', callback);
  }

  // Simulator trigger (Phase-1)
  triggerSimulator(gateId: string, event: SimulatorEvent, data?: object): void {
    this.socket.emit('simulator:trigger', { gateId, event, ...data });
  }

  // Cleanup
  disconnect(): void {
    this.socket.disconnect();
  }
}
```
