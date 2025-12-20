# GateRecord Deployment Guide

Complete guide to deploy GateRecord to production with all services.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLOUD SERVER                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   Nginx     │  │  Backend    │  │  PostgreSQL │             │
│  │  (Reverse   │──│  (NestJS)   │──│  Database   │             │
│  │   Proxy)    │  │  Port 3001  │  │  Port 5432  │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│         │               │                                       │
│         │         ┌─────────────┐  ┌─────────────┐             │
│         │         │    MQTT     │  │    SMTP     │             │
│         │         │  Mosquitto  │  │  (Mailpit/  │             │
│         │         │  Port 1883  │  │  SendGrid)  │             │
│         │         └─────────────┘  └─────────────┘             │
│  ┌─────────────┐        │                                       │
│  │  Frontend   │        │                                       │
│  │   (Static)  │        │                                       │
│  │  Port 80/443│        │                                       │
│  └─────────────┘        │                                       │
└─────────────────────────│───────────────────────────────────────┘
                          │
                    ┌─────────────┐
                    │   ESP32     │
                    │   Devices   │
                    │  (On-site)  │
                    └─────────────┘
```

## Prerequisites

- Ubuntu 22.04 LTS server (or similar)
- Domain name pointing to your server
- Minimum 2GB RAM, 2 CPU cores
- Open ports: 80, 443, 1883 (MQTT), 8883 (MQTT SSL)

---

## Step 1: Server Setup

### 1.1 Initial Server Configuration

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y curl wget git nginx certbot python3-certbot-nginx ufw

# Configure firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw allow 1883/tcp  # MQTT
sudo ufw allow 8883/tcp  # MQTT SSL
sudo ufw enable
```

### 1.2 Install Docker

```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add your user to docker group
sudo usermod -aG docker $USER

# Install Docker Compose
sudo apt install -y docker-compose-plugin

# Verify installation
docker --version
docker compose version
```

### 1.3 Install Node.js (for building)

```bash
# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version
npm --version
```

---

## Step 2: Clone and Configure

### 2.1 Clone Repository

```bash
# Create app directory
sudo mkdir -p /opt/gaterecord
sudo chown $USER:$USER /opt/gaterecord
cd /opt/gaterecord

# Clone repository
git clone https://github.com/pmc-tool/gaterecord.git .
```

### 2.2 Create Environment Files

**Backend Environment** (`/opt/gaterecord/backend/.env`):

```bash
cat > /opt/gaterecord/backend/.env << 'EOF'
# Application
NODE_ENV=production
PORT=3001

# Database
DB_HOST=postgres
DB_PORT=5432
DB_USERNAME=gaterecord
DB_PASSWORD=YOUR_STRONG_DB_PASSWORD_HERE
DB_DATABASE=gaterecord

# JWT Secrets (generate with: openssl rand -base64 64)
JWT_SECRET=YOUR_JWT_SECRET_HERE
JWT_REFRESH_SECRET=YOUR_JWT_REFRESH_SECRET_HERE
JWT_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d

# MQTT Broker
MQTT_BROKER_URL=mqtt://mosquitto:1883
MQTT_USERNAME=gaterecord
MQTT_PASSWORD=YOUR_MQTT_PASSWORD_HERE

# SMTP Configuration
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=YOUR_SENDGRID_API_KEY
SMTP_FROM=noreply@yourdomain.com

# Frontend URL (for emails)
FRONTEND_URL=https://yourdomain.com

# File uploads
UPLOAD_DIR=/app/uploads
MAX_FILE_SIZE=10485760
EOF
```

**Generate Secrets:**

```bash
# Generate JWT secrets
echo "JWT_SECRET: $(openssl rand -base64 64 | tr -d '\n')"
echo "JWT_REFRESH_SECRET: $(openssl rand -base64 64 | tr -d '\n')"
echo "DB_PASSWORD: $(openssl rand -base64 32 | tr -d '\n')"
echo "MQTT_PASSWORD: $(openssl rand -base64 24 | tr -d '\n')"
```

**Frontend Environment** (`/opt/gaterecord/frontend/.env`):

```bash
cat > /opt/gaterecord/frontend/.env << 'EOF'
VITE_API_URL=https://api.yourdomain.com/api/v1
VITE_WS_URL=wss://api.yourdomain.com
EOF
```

---

## Step 3: Docker Compose Setup

### 3.1 Create Production Docker Compose

```bash
cat > /opt/gaterecord/docker-compose.prod.yml << 'EOF'
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    container_name: gaterecord-db
    restart: always
    environment:
      POSTGRES_USER: gaterecord
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: gaterecord
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - gaterecord-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gaterecord"]
      interval: 10s
      timeout: 5s
      retries: 5

  mosquitto:
    image: eclipse-mosquitto:2
    container_name: gaterecord-mqtt
    restart: always
    ports:
      - "1883:1883"
      - "8883:8883"
    volumes:
      - ./mosquitto/config:/mosquitto/config
      - ./mosquitto/data:/mosquitto/data
      - ./mosquitto/log:/mosquitto/log
      - ./mosquitto/certs:/mosquitto/certs
    networks:
      - gaterecord-network

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: gaterecord-backend
    restart: always
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
    env_file:
      - ./backend/.env
    volumes:
      - backend_uploads:/app/uploads
    depends_on:
      postgres:
        condition: service_healthy
      mosquitto:
        condition: service_started
    networks:
      - gaterecord-network

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    container_name: gaterecord-frontend
    restart: always
    ports:
      - "8080:80"
    depends_on:
      - backend
    networks:
      - gaterecord-network

volumes:
  postgres_data:
  backend_uploads:

networks:
  gaterecord-network:
    driver: bridge
EOF
```

### 3.2 Create Backend Dockerfile

```bash
cat > /opt/gaterecord/backend/Dockerfile << 'EOF'
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build application
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built application
COPY --from=builder /app/dist ./dist

# Create uploads directory
RUN mkdir -p /app/uploads

# Expose port
EXPOSE 3001

# Start application
CMD ["node", "dist/main.js"]
EOF
```

### 3.3 Create Frontend Dockerfile

```bash
cat > /opt/gaterecord/frontend/Dockerfile << 'EOF'
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build application
RUN npm run build

# Production stage with Nginx
FROM nginx:alpine AS production

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
EOF
```

### 3.4 Create Frontend Nginx Config

```bash
cat > /opt/gaterecord/frontend/nginx.conf << 'EOF'
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # Handle SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
EOF
```

---

## Step 4: MQTT Broker Setup

### 4.1 Create Mosquitto Configuration

```bash
# Create directories
mkdir -p /opt/gaterecord/mosquitto/{config,data,log,certs}

# Create password file
cat > /opt/gaterecord/mosquitto/config/mosquitto.conf << 'EOF'
# Mosquitto Configuration for GateRecord

# Persistence
persistence true
persistence_location /mosquitto/data/

# Logging
log_dest file /mosquitto/log/mosquitto.log
log_type all

# Default listener (internal Docker network)
listener 1883
protocol mqtt

# Authentication
allow_anonymous false
password_file /mosquitto/config/passwd

# Access Control
acl_file /mosquitto/config/acl

# WebSocket listener (for web clients)
listener 9001
protocol websockets

# SSL/TLS listener (for external devices)
# Uncomment after setting up certificates
# listener 8883
# protocol mqtt
# cafile /mosquitto/certs/ca.crt
# certfile /mosquitto/certs/server.crt
# keyfile /mosquitto/certs/server.key
# require_certificate false
EOF
```

### 4.2 Create MQTT Users

```bash
# Create password file (replace YOUR_MQTT_PASSWORD with actual password)
docker run --rm -v /opt/gaterecord/mosquitto/config:/mosquitto/config \
  eclipse-mosquitto:2 mosquitto_passwd -c -b /mosquitto/config/passwd gaterecord YOUR_MQTT_PASSWORD

# Add device user
docker run --rm -v /opt/gaterecord/mosquitto/config:/mosquitto/config \
  eclipse-mosquitto:2 mosquitto_passwd -b /mosquitto/config/passwd device DEVICE_PASSWORD
```

### 4.3 Create MQTT ACL

```bash
cat > /opt/gaterecord/mosquitto/config/acl << 'EOF'
# GateRecord MQTT Access Control

# Backend has full access
user gaterecord
topic readwrite #

# Devices can publish to their topics and subscribe to commands
pattern readwrite gate/%c/#
pattern read gate/+/command
pattern write gate/+/status
pattern write gate/+/event
pattern write gate/+/heartbeat
EOF
```

---

## Step 5: SMTP Setup

### Option A: SendGrid (Recommended for Production)

1. Create account at https://sendgrid.com
2. Create API key with "Mail Send" permission
3. Verify sender email/domain
4. Update `.env`:

```bash
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=SG.your-api-key-here
SMTP_FROM=noreply@yourdomain.com
```

### Option B: AWS SES

```bash
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=YOUR_AWS_SES_SMTP_USER
SMTP_PASS=YOUR_AWS_SES_SMTP_PASSWORD
SMTP_FROM=noreply@yourdomain.com
```

### Option C: Gmail (Development/Testing Only)

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=your-email@gmail.com
```

### Option D: Mailpit (Local Testing)

Add to docker-compose.prod.yml:

```yaml
  mailpit:
    image: axllent/mailpit
    container_name: gaterecord-mailpit
    restart: always
    ports:
      - "8025:8025"  # Web UI
      - "1025:1025"  # SMTP
    networks:
      - gaterecord-network
```

Update `.env`:
```bash
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@gaterecord.local
```

---

## Step 6: Nginx Reverse Proxy

### 6.1 Create Nginx Configuration

```bash
sudo cat > /etc/nginx/sites-available/gaterecord << 'EOF'
# Frontend
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Backend API
server {
    listen 80;
    server_name api.yourdomain.com;

    client_max_body_size 50M;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support
    location /socket.io {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF

# Enable site
sudo ln -s /etc/nginx/sites-available/gaterecord /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

### 6.2 Setup SSL with Let's Encrypt

```bash
# Install SSL certificates
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com -d api.yourdomain.com

# Auto-renewal is configured automatically
# Test renewal
sudo certbot renew --dry-run
```

---

## Step 7: Deploy Application

### 7.1 Build and Start Services

```bash
cd /opt/gaterecord

# Create .env file for docker-compose
cat > .env << 'EOF'
DB_PASSWORD=YOUR_STRONG_DB_PASSWORD_HERE
EOF

# Build and start all services
docker compose -f docker-compose.prod.yml up -d --build

# Check status
docker compose -f docker-compose.prod.yml ps

# View logs
docker compose -f docker-compose.prod.yml logs -f
```

### 7.2 Run Database Migrations

```bash
# Run migrations
docker compose -f docker-compose.prod.yml exec backend npm run migration:run

# Seed initial data (plans, super admin)
docker compose -f docker-compose.prod.yml exec backend npm run seed
```

### 7.3 Create Super Admin

```bash
# Connect to backend container
docker compose -f docker-compose.prod.yml exec backend sh

# Inside container, run seed or create admin manually
npm run seed:admin
```

---

## Step 8: ESP32 Firmware Configuration

### 8.1 Update Firmware for Production

Edit `firmware/gate_controller/src/main.cpp`:

```cpp
// Production MQTT Settings
#define MQTT_SERVER "your-server-ip-or-domain"  // Your server's public IP or domain
#define MQTT_PORT 1883                           // Or 8883 for SSL
#define MQTT_USER "device"
#define MQTT_PASS "DEVICE_PASSWORD"

// For SSL connection (recommended)
// #define MQTT_PORT 8883
// #define MQTT_USE_SSL true
```

### 8.2 Build and Flash

```bash
cd firmware/gate_controller

# Update platformio.ini if needed
# Build
pio run

# Flash to device
pio run -t upload
```

### 8.3 Device Registration

1. Power on ESP32
2. Connect to "GateSetup-XXXXXX" WiFi
3. Navigate to 192.168.4.1
4. Enter:
   - WiFi credentials
   - MQTT server: `your-server-ip` or `mqtt.yourdomain.com`
   - MQTT port: `1883`
   - Device will auto-register with backend

---

## Step 9: SSL for MQTT (Optional but Recommended)

### 9.1 Generate Certificates

```bash
cd /opt/gaterecord/mosquitto/certs

# Generate CA key and certificate
openssl genrsa -out ca.key 2048
openssl req -new -x509 -days 3650 -key ca.key -out ca.crt \
  -subj "/CN=GateRecord MQTT CA"

# Generate server key and CSR
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr \
  -subj "/CN=mqtt.yourdomain.com"

# Sign server certificate
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out server.crt -days 3650

# Set permissions
chmod 644 *.crt
chmod 600 *.key
```

### 9.2 Enable SSL in Mosquitto

Uncomment SSL section in `/opt/gaterecord/mosquitto/config/mosquitto.conf`:

```conf
listener 8883
protocol mqtt
cafile /mosquitto/certs/ca.crt
certfile /mosquitto/certs/server.crt
keyfile /mosquitto/certs/server.key
require_certificate false
```

Restart mosquitto:
```bash
docker compose -f docker-compose.prod.yml restart mosquitto
```

---

## Step 10: Monitoring & Maintenance

### 10.1 Setup Log Rotation

```bash
sudo cat > /etc/logrotate.d/gaterecord << 'EOF'
/opt/gaterecord/mosquitto/log/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
}
EOF
```

### 10.2 Backup Script

```bash
cat > /opt/gaterecord/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/opt/backups/gaterecord"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Backup database
docker compose -f /opt/gaterecord/docker-compose.prod.yml exec -T postgres \
  pg_dump -U gaterecord gaterecord | gzip > $BACKUP_DIR/db_$DATE.sql.gz

# Backup uploads
tar -czf $BACKUP_DIR/uploads_$DATE.tar.gz -C /opt/gaterecord/backend uploads/

# Keep only last 7 days
find $BACKUP_DIR -type f -mtime +7 -delete

echo "Backup completed: $DATE"
EOF

chmod +x /opt/gaterecord/backup.sh

# Add to crontab (daily at 2 AM)
echo "0 2 * * * /opt/gaterecord/backup.sh >> /var/log/gaterecord-backup.log 2>&1" | sudo tee -a /etc/crontab
```

### 10.3 Health Check Script

```bash
cat > /opt/gaterecord/healthcheck.sh << 'EOF'
#!/bin/bash

# Check all services
echo "=== GateRecord Health Check ==="
echo ""

# Backend
if curl -s http://localhost:3001/api/v1/health > /dev/null; then
    echo "✓ Backend: OK"
else
    echo "✗ Backend: FAILED"
fi

# Frontend
if curl -s http://localhost:8080 > /dev/null; then
    echo "✓ Frontend: OK"
else
    echo "✗ Frontend: FAILED"
fi

# PostgreSQL
if docker compose -f /opt/gaterecord/docker-compose.prod.yml exec -T postgres pg_isready > /dev/null; then
    echo "✓ PostgreSQL: OK"
else
    echo "✗ PostgreSQL: FAILED"
fi

# MQTT
if nc -z localhost 1883; then
    echo "✓ MQTT: OK"
else
    echo "✗ MQTT: FAILED"
fi

# SSL Certificate expiry
echo ""
echo "=== SSL Certificate Status ==="
sudo certbot certificates
EOF

chmod +x /opt/gaterecord/healthcheck.sh
```

### 10.4 Update Script

```bash
cat > /opt/gaterecord/update.sh << 'EOF'
#!/bin/bash
cd /opt/gaterecord

echo "=== Updating GateRecord ==="

# Pull latest code
git pull origin main

# Rebuild and restart services
docker compose -f docker-compose.prod.yml up -d --build

# Run migrations
docker compose -f docker-compose.prod.yml exec backend npm run migration:run

echo "=== Update Complete ==="
docker compose -f docker-compose.prod.yml ps
EOF

chmod +x /opt/gaterecord/update.sh
```

---

## Step 11: Troubleshooting

### Common Issues

**1. Backend can't connect to database**
```bash
# Check database is running
docker compose -f docker-compose.prod.yml ps postgres

# Check logs
docker compose -f docker-compose.prod.yml logs postgres

# Verify connection
docker compose -f docker-compose.prod.yml exec postgres psql -U gaterecord -d gaterecord
```

**2. MQTT connection refused**
```bash
# Check mosquitto is running
docker compose -f docker-compose.prod.yml ps mosquitto

# Check logs
docker compose -f docker-compose.prod.yml logs mosquitto

# Test connection
mosquitto_pub -h localhost -p 1883 -u gaterecord -P YOUR_PASSWORD -t test -m "hello"
```

**3. ESP32 can't connect**
```bash
# Check MQTT port is open
sudo ufw status
nc -zv your-server-ip 1883

# Check mosquitto logs for connection attempts
docker compose -f docker-compose.prod.yml logs -f mosquitto
```

**4. Email not sending**
```bash
# Check backend logs
docker compose -f docker-compose.prod.yml logs backend | grep -i mail

# Test SMTP connection
docker compose -f docker-compose.prod.yml exec backend sh
# Inside container:
node -e "require('nodemailer').createTransport({host:'smtp.sendgrid.net',port:587,auth:{user:'apikey',pass:'YOUR_KEY'}}).verify().then(console.log).catch(console.error)"
```

**5. WebSocket not working**
```bash
# Check nginx config
sudo nginx -t

# Verify WebSocket upgrade headers
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" http://api.yourdomain.com/socket.io/
```

---

## Quick Reference

### Service Ports

| Service | Internal Port | External Port |
|---------|---------------|---------------|
| Frontend | 80 | 8080 → 80/443 (nginx) |
| Backend | 3001 | 3001 → 80/443 (nginx) |
| PostgreSQL | 5432 | Internal only |
| MQTT | 1883 | 1883 |
| MQTT SSL | 8883 | 8883 |
| MQTT WebSocket | 9001 | 9001 |

### Essential Commands

```bash
# Start all services
docker compose -f docker-compose.prod.yml up -d

# Stop all services
docker compose -f docker-compose.prod.yml down

# View logs
docker compose -f docker-compose.prod.yml logs -f [service]

# Restart a service
docker compose -f docker-compose.prod.yml restart [service]

# Run migrations
docker compose -f docker-compose.prod.yml exec backend npm run migration:run

# Database shell
docker compose -f docker-compose.prod.yml exec postgres psql -U gaterecord

# Backend shell
docker compose -f docker-compose.prod.yml exec backend sh
```

### Environment Variables Checklist

- [ ] `DB_PASSWORD` - Strong database password
- [ ] `JWT_SECRET` - Random 64+ character string
- [ ] `JWT_REFRESH_SECRET` - Random 64+ character string
- [ ] `MQTT_PASSWORD` - MQTT broker password
- [ ] `SMTP_HOST` - Email server host
- [ ] `SMTP_USER` - Email username/API key
- [ ] `SMTP_PASS` - Email password
- [ ] `FRONTEND_URL` - Your frontend domain
- [ ] Domain names configured in Nginx
- [ ] SSL certificates installed

---

## Support

For issues:
1. Check logs: `docker compose -f docker-compose.prod.yml logs -f`
2. Run health check: `/opt/gaterecord/healthcheck.sh`
3. Open issue at: https://github.com/pmc-tool/gaterecord/issues
