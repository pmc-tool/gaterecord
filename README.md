# Gate Management System

A multi-tenant SaaS platform for residential building access control with ESP32 hardware integration, real-time monitoring, and comprehensive visitor management.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Hardware Setup](#hardware-setup)
- [API Reference](#api-reference)
- [Development](#development)
- [Deployment](#deployment)

---

## Overview

The Gate Management System is a complete access control solution for residential buildings that combines:

- **Cloud Platform**: Multi-tenant SaaS backend with real-time dashboards
- **Hardware Integration**: ESP32-based gate controllers with RFID, sensors, and actuators
- **Visitor Management**: QR code-based temporary access passes
- **Security Monitoring**: Real-time alerts, event logging, and incident management

### Key Use Cases

- Residential apartment complexes
- Gated communities
- Office buildings
- Parking facilities

---

## Features

### Access Control
- **Vehicle RFID**: Automatic gate opening for registered vehicles
- **Human RFID**: Card-based access for residents and staff
- **QR Code Passes**: Temporary visitor credentials with configurable validity
- **Manual Override**: Web-based gate control for authorized personnel

### Multi-Tenant Management
- Isolated data per building/tenant
- Subscription-based feature access
- Super admin dashboard for platform management
- Per-tenant analytics and reporting

### Real-Time Monitoring
- Live access event streaming
- Gate status updates via WebSocket
- Security alert notifications
- Device health monitoring

### Security
- Role-based access control (5 roles)
- JWT authentication with refresh tokens
- Security alert system with buzzer alarms
- Unauthorized visitor reporting

### Hardware Features
- OLED display for status messages
- RFID card reading (MFRC522)
- Servo-based gate actuation
- Obstacle detection (IR + Ultrasonic)
- Audio/visual feedback (Buzzer + LEDs)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                        │
│                    Port 3000 / Port 5173 (dev)                  │
└─────────────────────────┬───────────────────────────────────────┘
                          │ HTTP/WebSocket
┌─────────────────────────▼───────────────────────────────────────┐
│                      Backend (NestJS)                           │
│                         Port 3001                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │   Auth   │ │  Gates   │ │ Visitors │ │ Security Alerts  │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │  Tenants │ │   RFID   │ │ Vehicles │ │    Simulator     │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
└───────┬─────────────────────────┬───────────────────────────────┘
        │                         │
        │ PostgreSQL              │ MQTT
        ▼                         ▼
┌───────────────┐         ┌───────────────┐
│   Database    │         │  MQTT Broker  │
│  PostgreSQL   │         │   Mosquitto   │
│   Port 5432   │         │   Port 1883   │
└───────────────┘         └───────┬───────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
              ┌─────▼─────┐               ┌─────▼─────┐
              │   ESP32   │               │   ESP32   │
              │  Gate #1  │               │  Gate #2  │
              └───────────┘               └───────────┘
```

---

## Tech Stack

### Backend
| Technology | Version | Purpose |
|------------|---------|---------|
| NestJS | 10.x | API Framework |
| TypeScript | 5.x | Language |
| PostgreSQL | 16 | Database |
| TypeORM | 0.3.x | ORM |
| Socket.IO | 4.x | Real-time |
| MQTT | - | IoT Communication |
| Passport | 0.7.x | Authentication |

### Frontend
| Technology | Version | Purpose |
|------------|---------|---------|
| React | 18.x | UI Framework |
| TypeScript | 5.x | Language |
| Vite | 5.x | Build Tool |
| Ant Design | 5.x | UI Components |
| Zustand | 5.x | State Management |
| Tailwind CSS | 3.x | Styling |

### Hardware
| Component | Model | Purpose |
|-----------|-------|---------|
| Microcontroller | ESP32 DevKit V1 | Main controller |
| Display | SSD1306 OLED 128x64 | Status display |
| RFID Reader | MFRC522 | Card reading |
| Servo | SG90 | Gate actuation |
| IR Sensor | Generic | Obstacle detection |
| Ultrasonic | HC-SR04 | Distance sensing |

---

## Quick Start

### Prerequisites

- Node.js 20 LTS
- PostgreSQL 16
- MQTT Broker (Mosquitto)
- PlatformIO (for firmware)

### 1. Clone Repository

```bash
git clone <repository-url>
cd Gate
```

### 2. Database Setup

```bash
# Using Docker
docker-compose up -d postgres

# Or manually create database
createdb gate_management
```

### 3. Backend Setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your configuration
npm run start:dev
```

### 4. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

### 5. Seed Database

```bash
cd backend
npm run seed
```

### 6. Access Application

- **Frontend**: http://localhost:3000
- **API**: http://localhost:3001/api/v1
- **Swagger Docs**: http://localhost:3001/api/docs

### Default Credentials

| Role | Email | Password |
|------|-------|----------|
| Super Admin | admin@gatemanagement.com | Admin123! |
| Building Admin | admin@building1.com | Building123! |
| Security | security@building1.com | Security123! |
| Resident | jane.smith@building1.com | Resident123! |

---

## Configuration

### Backend Environment Variables

```env
# Server
PORT=3001
NODE_ENV=development

# Database
DATABASE_URL=postgresql://username:password@localhost:5432/gate_management
DATABASE_SSL=false

# JWT Authentication
JWT_SECRET=your-super-secret-key-change-in-production
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d

# MQTT
MQTT_BROKER_URL=mqtt://localhost:1883
MQTT_USERNAME=
MQTT_PASSWORD=

# Frontend URL (for email links)
FRONTEND_URL=http://localhost:3000

# CORS
CORS_ORIGIN=http://localhost:3000

# Email (Mailpit for development)
SMTP_HOST=localhost
SMTP_PORT=1025
```

### Frontend Environment Variables

```env
VITE_API_URL=http://localhost:3001/api/v1
VITE_WS_URL=http://localhost:3001
```

### Firmware Configuration

Edit `firmware/gate_controller/src/main.cpp`:

```cpp
// WiFi Configuration
const char* WIFI_SSID = "YourWiFiSSID";
const char* WIFI_PASSWORD = "YourWiFiPassword";

// MQTT Configuration
const char* MQTT_BROKER = "192.168.1.100";  // Your server IP
const int MQTT_PORT = 1883;
```

---

## Hardware Setup

### Pin Configuration

```
ESP32 DevKit V1
├── OLED Display (I2C)
│   ├── SDA → GPIO 26
│   └── SCL → GPIO 27
├── RFID Reader (SPI)
│   ├── SCK  → GPIO 18
│   ├── MISO → GPIO 19
│   ├── MOSI → GPIO 23
│   ├── SS   → GPIO 4
│   └── RST  → GPIO 17
├── Servo Motor
│   └── Signal → GPIO 14
├── IR Obstacle Sensor
│   └── OUT → GPIO 34
├── Ultrasonic Sensor
│   ├── TRIG → GPIO 32
│   └── ECHO → GPIO 33
├── Buzzer
│   └── Signal → GPIO 25
└── LEDs
    ├── Green → GPIO 13
    └── Red   → GPIO 12
```

### Wiring Diagram

```
                    ┌──────────────────┐
                    │      ESP32       │
                    │                  │
   OLED ◄──────────│ GPIO 26 (SDA)    │
   Display ◄───────│ GPIO 27 (SCL)    │
                    │                  │
   RFID ◄──────────│ GPIO 18 (SCK)    │
   Reader ◄────────│ GPIO 19 (MISO)   │
         ◄─────────│ GPIO 23 (MOSI)   │
         ◄─────────│ GPIO 4 (SS)      │
         ◄─────────│ GPIO 17 (RST)    │
                    │                  │
   Servo ◄─────────│ GPIO 14          │
                    │                  │
   IR Sensor ◄─────│ GPIO 34          │
                    │                  │
   Ultrasonic ◄────│ GPIO 32 (TRIG)   │
             ◄─────│ GPIO 33 (ECHO)   │
                    │                  │
   Buzzer ◄────────│ GPIO 25          │
                    │                  │
   Green LED ◄─────│ GPIO 13          │
   Red LED ◄───────│ GPIO 12          │
                    │                  │
                    │ 3.3V ──────────► │ VCC (sensors)
                    │ GND ───────────► │ GND (all)
                    └──────────────────┘
```

### Firmware Upload

```bash
cd firmware/gate_controller

# Build
pio run

# Upload
pio run -t upload

# Monitor serial output
pio device monitor -b 115200
```

### Device Registration

1. Power on the ESP32
2. Note the Device ID shown on OLED (MAC address)
3. In the web app, edit the gate and enter the Hardware ID
4. The gate will connect automatically via MQTT

---

## API Reference

### Authentication

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "admin@building1.com",
  "password": "Building123!"
}
```

Response:
```json
{
  "accessToken": "eyJhbG...",
  "refreshToken": "uuid...",
  "user": {
    "id": "uuid",
    "email": "admin@building1.com",
    "role": "building_admin",
    "tenantId": "uuid"
  }
}
```

### Gates

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /gates | List all gates |
| POST | /gates | Create gate |
| GET | /gates/:id | Get gate details |
| PATCH | /gates/:id | Update gate |
| DELETE | /gates/:id | Delete gate |
| GET | /gates/:id/health | Get health status |

### Visitor Passes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /visitor-passes | List passes |
| POST | /visitor-passes | Create pass |
| GET | /visitor-passes/:id | Get pass details |
| GET | /visitor-passes/:id/qr | Get QR code |
| POST | /visitor-passes/:id/cancel | Cancel pass |

### Security Alerts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /security-alerts | List alerts |
| GET | /security-alerts/active | Get active alerts |
| PATCH | /security-alerts/:id/acknowledge | Acknowledge alert |
| PATCH | /security-alerts/:id/resolve | Resolve alert |
| POST | /security-alerts/report-unauthorized | Report incident (public) |

### Access Events

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /events | List events with filters |
| GET | /events/live | Get recent events |
| GET | /events/stats | Get statistics |
| GET | /events/export | Export to CSV |

Full API documentation available at `/api/docs` (Swagger UI).

---

## Development

### Project Structure

```
Gate/
├── backend/
│   ├── src/
│   │   ├── common/          # Guards, decorators, utilities
│   │   ├── database/
│   │   │   ├── entities/    # TypeORM entities
│   │   │   └── seeds/       # Database seeders
│   │   ├── modules/
│   │   │   ├── auth/        # Authentication
│   │   │   ├── gates/       # Gate management
│   │   │   ├── mqtt/        # MQTT service
│   │   │   ├── gateway/     # WebSocket gateway
│   │   │   ├── security-alert/
│   │   │   ├── visitor-pass/
│   │   │   └── ...
│   │   └── main.ts
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── services/
│   │   ├── stores/
│   │   └── App.tsx
│   └── package.json
├── firmware/
│   └── gate_controller/
│       ├── src/
│       │   └── main.cpp
│       └── platformio.ini
└── docker-compose.yml
```

### Running Tests

```bash
# Backend tests
cd backend
npm run test
npm run test:e2e

# Frontend tests
cd frontend
npm run test
```

### Code Style

```bash
# Lint
npm run lint

# Format
npm run format
```

### Database Migrations

```bash
# Generate migration
npm run typeorm migration:generate -- -n MigrationName

# Run migrations
npm run typeorm migration:run
```

---

## Deployment

### Docker Compose (Development)

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: gate_management
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  mosquitto:
    image: eclipse-mosquitto:2
    ports:
      - "1883:1883"
    volumes:
      - ./mosquitto.conf:/mosquitto/config/mosquitto.conf

  mailpit:
    image: axllent/mailpit
    ports:
      - "1025:1025"
      - "8025:8025"

volumes:
  postgres_data:
```

### Production Checklist

- [ ] Set strong JWT_SECRET
- [ ] Enable DATABASE_SSL
- [ ] Configure proper CORS origins
- [ ] Set up MQTT authentication
- [ ] Configure email provider (replace Mailpit)
- [ ] Enable HTTPS
- [ ] Set up monitoring and logging
- [ ] Configure backup strategy

---

## User Roles

| Role | Permissions |
|------|-------------|
| **SUPER_ADMIN** | Full platform access, tenant management, subscription plans |
| **BUILDING_ADMIN** | Full building access, user management, gate configuration |
| **SECURITY** | Gate control, event monitoring, alert management |
| **RESIDENT** | Visitor pass creation, personal event history |
| **STAFF** | Limited access based on assignment |

---

## MQTT Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `gate/{deviceId}/status` | Device → Server | Heartbeat and status |
| `gate/{deviceId}/event` | Device → Server | Access events |
| `gate/{deviceId}/sensors` | Device → Server | Sensor readings |
| `gate/{deviceId}/command` | Server → Device | Control commands |
| `gate/{deviceId}/display` | Server → Device | OLED messages |
| `gate/{deviceId}/feedback` | Server → Device | Audio/visual feedback |
| `gate/{deviceId}/alarm` | Server → Device | Security alarm control |

### Command Payloads

```json
// Open gate
{ "command": "OPEN", "timestamp": "ISO8601" }

// Display message
{ "line1": "Welcome", "line2": "John Doe", "timestamp": "ISO8601" }

// Trigger alarm
{ "action": "START", "alertId": "uuid", "timestamp": "ISO8601" }
```

---

## Troubleshooting

### Gate Not Connecting

1. Verify WiFi credentials in firmware
2. Check MQTT broker is running: `mosquitto_sub -t "gate/#" -v`
3. Verify Hardware ID matches in web app
4. Check serial monitor for connection status

### RFID Not Reading

1. Verify wiring (SPI connections)
2. Check MFRC522 is powered (3.3V)
3. Hold card closer to reader
4. Check serial output for debug info

### Alarm Not Triggering

1. Verify MQTT connection: `GET /api/v1/security-alerts/mqtt-status`
2. Check gate has Hardware ID configured
3. Test directly: `POST /api/v1/security-alerts/test-alarm/{hardwareId}`

---

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

---

## License

This project is proprietary software. All rights reserved.

---

## Support

For issues and feature requests, please use the GitHub Issues page.
