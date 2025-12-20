# Device Setup Wizard - Implementation Plan (v3 - Final)

## Overview

A complete no-code device provisioning system that allows building administrators to:
1. Flash firmware to ESP32 via WebSerial (browser-based, inside dashboard)
2. Configure device via WiFi captive portal (phone-friendly)
3. Manage devices and trigger OTA updates from dashboard
4. Automatic update checks on device boot

**Key Principles:**
- One universal firmware for all devices
- Phone-friendly setup via WiFi captive portal
- Setup codes for secure tenant pairing
- OTA updates triggered from dashboard OR auto-check on boot
- Simple recovery via button hold
- Offline mode with local event queue

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE DEVICE LIFECYCLE                            │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
  │  FLASH   │──▶│  SETUP   │──▶│  CLAIM   │──▶│  NORMAL  │──▶│   OTA    │
  │(WebSerial│   │  MODE    │   │(Pairing) │   │OPERATION │   │  UPDATE  │
  │Dashboard)│   │(AP+Portal│   │          │   │          │   │          │
  └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
       │              │              │              │              │
       │              │              │              │              │
   Admin flashes  Creates WiFi   Validates     Heartbeat      Auto-check
   from browser   hotspot        setup code    every 60s      on boot
                  User enters    Returns       Events via     OR manual
                  WiFi + code    MQTT creds    MQTT           trigger
```

---

## Configuration Summary

| Setting | Value |
|---------|-------|
| API URL | Hardcoded in firmware (SaaS model) |
| MQTT Broker | Same server as API (mqtt.yoursite.com:8883) |
| Firmware Flasher | Inside dashboard (requires login) |
| Re-pairing | Same building admins only |
| Update Check | Automatic on every boot + manual trigger |
| Heartbeat | Every 60 seconds |
| Offline Threshold | 2 minutes without heartbeat |
| Setup Code Expiry | 15 minutes |
| Setup Code Format | XXX-XXX-XXX (9 chars, easy to type) |
| Offline Event Queue | Max 100 events in NVS |

---

## Flow 1: Initial Firmware Flash (WebSerial in Dashboard)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    WEBSERIAL FIRMWARE FLASHER (Dashboard)                    │
└─────────────────────────────────────────────────────────────────────────────┘

Admin logs into dashboard → Devices → Flash New Device

┌─────────────────────────────────────────────────────────────────┐
│  ⚡ Flash New Device                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Prerequisites:                                                  │
│  ✓ Chrome or Edge browser                                       │
│  ✓ ESP32 DevKit V1                                              │
│  ✓ USB cable connected                                          │
│                                                                  │
│  ───────────────────────────────────────────────────────────    │
│                                                                  │
│  Step 1: Connect Device                                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  🔌 No device connected                                 │    │
│  │                                                         │    │
│  │  1. Connect ESP32 to computer via USB                   │    │
│  │  2. Hold BOOT button on ESP32                           │    │
│  │  3. Click "Connect" below                               │    │
│  │                                                         │    │
│  │            [Connect Device]                             │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  [Show Video Tutorial]                                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

After clicking Connect → Browser shows port selection:
┌─────────────────────────────────────┐
│  Select a serial port               │
│  ┌─────────────────────────────────┐│
│  │ CP2102 USB to UART Bridge       ││ ← User selects ESP32
│  │ /dev/cu.usbserial-0001          ││
│  └─────────────────────────────────┘│
│  [Cancel]              [Connect]    │
└─────────────────────────────────────┘

After connection:
┌─────────────────────────────────────────────────────────────────┐
│  ⚡ Flash New Device                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Step 1: Connect Device                                          │
│  ✅ Device connected: CP2102 USB to UART                        │
│                                                                  │
│  Step 2: Flash Firmware                                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Ready to flash firmware v1.3.0                         │    │
│  │  Size: 1.2 MB                                           │    │
│  │                                                         │    │
│  │  ⚠️ This will erase existing firmware on the device     │    │
│  │                                                         │    │
│  │            [Flash Firmware]                             │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

During flash:
┌─────────────────────────────────────────────────────────────────┐
│  ⚡ Flashing...                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ████████████████████░░░░░░░░░░ 65%                             │
│                                                                  │
│  Status: Writing firmware to flash...                           │
│                                                                  │
│  ⚠️ Do not disconnect the device!                               │
│                                                                  │
│  Console output:                                                │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Connecting to ESP32...                                  │    │
│  │ Chip: ESP32-D0WDQ6                                      │    │
│  │ Features: WiFi, BT, Dual Core                           │    │
│  │ Erasing flash...                                        │    │
│  │ Writing at 0x00010000... (65%)                          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

Success:
┌─────────────────────────────────────────────────────────────────┐
│  ✅ Flash Complete!                                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Firmware v1.3.0 has been successfully flashed.                 │
│                                                                  │
│  Next Steps:                                                     │
│  1. Disconnect USB cable                                         │
│  2. Power on the device (or it will auto-restart)               │
│  3. Connect to WiFi "GateController-XXXXXX"                     │
│  4. Complete setup in the captive portal                        │
│                                                                  │
│  [Generate Setup Code]  [Flash Another]  [Done]                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Flow 2: Setup Code Generation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SETUP CODE GENERATION                                │
└─────────────────────────────────────────────────────────────────────────────┘

Dashboard → Devices → Add Device

┌─────────────────────────────────────────────────────────────────┐
│  📱 Add New Device                                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Device Name *                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Main Entry Controller                                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Assign to Gate                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Main Entry                                          ▼   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  [Cancel]                              [Generate Setup Code]    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

After generating:
┌─────────────────────────────────────────────────────────────────┐
│  📱 Setup Code Ready                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Your Setup Code:                                               │
│                                                                  │
│     ┌─────────────────────────────────────────────┐             │
│     │                                             │             │
│     │            ABC-DEF-GHJ                      │             │
│     │                                             │             │
│     └─────────────────────────────────────────────┘             │
│                                                                  │
│     ⏱️ Expires in: 14:32                                        │
│                                                                  │
│  ───────────────────────────────────────────────────────────    │
│                                                                  │
│  Instructions:                                                  │
│                                                                  │
│  1. Power on your ESP32 device                                  │
│     The device will create a WiFi hotspot                       │
│                                                                  │
│  2. On your phone, connect to WiFi:                             │
│     📶 GateController-XXXXXX                                    │
│                                                                  │
│  3. A setup page will open automatically                        │
│     (or go to http://192.168.4.1)                               │
│                                                                  │
│  4. Enter your building WiFi and this setup code                │
│                                                                  │
│  [Copy Code]  [Generate New Code]  [Close]                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Setup Code Generation Logic

```typescript
// setup-code.service.ts
@Injectable()
export class SetupCodeService {
  // Characters: Uppercase letters + numbers (excluding confusing: 0, O, I, L, 1)
  private readonly CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  generateCode(): string {
    let code = '';
    for (let i = 0; i < 9; i++) {
      if (i === 3 || i === 6) code += '-';
      code += this.CHARS[Math.floor(Math.random() * this.CHARS.length)];
    }
    return code; // e.g., "ABC-DEF-GHJ"
  }

  async createSetupCode(dto: CreateSetupCodeDto, user: User): Promise<SetupCode> {
    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    return this.setupCodeRepo.save({
      code,
      tenantId: user.tenantId,
      gateId: dto.gateId,
      deviceName: dto.deviceName,
      expiresAt,
      createdBy: user.id,
      status: 'pending',
    });
  }
}
```

---

## Flow 3: Captive Portal Setup (Phone)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CAPTIVE PORTAL SETUP                                 │
└─────────────────────────────────────────────────────────────────────────────┘

ESP32 boots → No config found → Creates AP: "GateController-A4CF12"

User connects phone to this WiFi → Captive portal opens:

┌─────────────────────────────────────────┐
│  🚪 Gate Controller Setup               │
├─────────────────────────────────────────┤
│                                         │
│  Step 1: Connect to Your WiFi           │
│  ─────────────────────────────────────  │
│                                         │
│  Network                                │
│  ┌─────────────────────────────────┐   │
│  │ Select network...            ▼  │   │
│  ├─────────────────────────────────┤   │
│  │ 📶 Home_Network_5G    (-45dBm) │   │ ← ESP32 scans
│  │ 📶 Office_WiFi        (-52dBm) │   │   available networks
│  │ 📶 Guest_Network      (-68dBm) │   │
│  │ ──────────────────────────────  │   │
│  │ ✏️ Enter manually...           │   │
│  └─────────────────────────────────┘   │
│                                         │
│  Password                               │
│  ┌─────────────────────────────────┐   │
│  │ ••••••••••••                    │   │
│  └─────────────────────────────────┘   │
│                                         │
│  Step 2: Enter Setup Code               │
│  ─────────────────────────────────────  │
│                                         │
│  Setup Code (from dashboard)            │
│  ┌─────────────────────────────────┐   │
│  │ ABC-DEF-GHJ                     │   │
│  └─────────────────────────────────┘   │
│                                         │
│       [ Complete Setup ]                │
│                                         │
│  ─────────────────────────────────────  │
│  Having trouble? Contact your           │
│  building administrator.                │
│                                         │
└─────────────────────────────────────────┘

Processing:
┌─────────────────────────────────────────┐
│  ⏳ Setting up...                       │
├─────────────────────────────────────────┤
│                                         │
│  ✓ Connecting to WiFi...                │
│  ⋯ Validating setup code...             │
│  ○ Saving configuration...              │
│                                         │
│  Please wait...                         │
│                                         │
└─────────────────────────────────────────┘

Success:
┌─────────────────────────────────────────┐
│  ✅ Setup Complete!                     │
├─────────────────────────────────────────┤
│                                         │
│  Your device is now configured:         │
│                                         │
│  ✓ Connected to: Home_Network_5G        │
│  ✓ Paired to: Sunrise Apartments        │
│  ✓ Assigned to: Main Entry              │
│                                         │
│  The device will restart and connect    │
│  to your building's system.             │
│                                         │
│  You can now disconnect from            │
│  "GateController-XXXXXX" WiFi.          │
│                                         │
│       [ Open Dashboard ]                │
│                                         │
└─────────────────────────────────────────┘

Error - Invalid Code:
┌─────────────────────────────────────────┐
│  ❌ Setup Failed                        │
├─────────────────────────────────────────┤
│                                         │
│  Invalid or expired setup code.         │
│                                         │
│  Please check:                          │
│  • Code is typed correctly              │
│  • Code hasn't expired (15 min limit)   │
│  • Code hasn't been used already        │
│                                         │
│  Contact your building administrator    │
│  for a new setup code.                  │
│                                         │
│       [ Try Again ]                     │
│                                         │
└─────────────────────────────────────────┘

Error - WiFi Failed:
┌─────────────────────────────────────────┐
│  ❌ WiFi Connection Failed              │
├─────────────────────────────────────────┤
│                                         │
│  Could not connect to "Home_Network_5G" │
│                                         │
│  Please check:                          │
│  • WiFi password is correct             │
│  • Network is within range              │
│  • Network is 2.4GHz (not 5GHz only)    │
│                                         │
│       [ Try Again ]                     │
│                                         │
└─────────────────────────────────────────┘
```

---

## Flow 4: Device Claim API

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLAIM API FLOW                                       │
└─────────────────────────────────────────────────────────────────────────────┘

ESP32 (after WiFi connects) → POST /api/v1/devices/claim

Request:
{
  "code": "ABC-DEF-GHJ",
  "deviceId": "A4:CF:12:XX:XX:XX",    // MAC address
  "wifiSsid": "Home_Network_5G",
  "firmwareVersion": "1.3.0"
}

Backend validates:
─────────────────
1. ✓ Code exists and not expired
2. ✓ Code not already claimed
3. ✓ Code belongs to a valid tenant
4. ✓ Device ID not already paired to DIFFERENT tenant
5. ✓ Rate limit not exceeded (5/min per IP)

Response (Success):
{
  "success": true,
  "config": {
    "tenantId": "uuid",
    "gateId": "uuid",
    "deviceName": "Main Entry Controller",
    "mqttBroker": "mqtt.gatemanagement.com",
    "mqttPort": 8883,
    "mqttUsername": "device_a4cf12xxxxxx",
    "mqttPassword": "generated_secure_password",
    "apiBaseUrl": "https://api.gatemanagement.com"
  }
}

Response (Error - Invalid Code):
{
  "success": false,
  "error": "INVALID_CODE",
  "message": "Setup code is invalid or expired"
}

Response (Error - Already Paired):
{
  "success": false,
  "error": "DEVICE_ALREADY_PAIRED",
  "message": "This device is already paired to another building"
}
```

### Re-pairing Logic

```typescript
// devices.service.ts
async claimDevice(dto: ClaimDeviceDto, ip: string): Promise<ClaimResponse> {
  // Rate limiting
  await this.checkRateLimit(ip, dto.code);

  // Validate setup code
  const setupCode = await this.setupCodeRepo.findOne({
    where: { code: dto.code, status: 'pending' },
    relations: ['tenant'],
  });

  if (!setupCode) {
    throw new BadRequestException('INVALID_CODE', 'Setup code is invalid');
  }

  if (new Date() > setupCode.expiresAt) {
    await this.setupCodeRepo.update(setupCode.id, { status: 'expired' });
    throw new BadRequestException('CODE_EXPIRED', 'Setup code has expired');
  }

  // Check if device already exists
  const existingDevice = await this.deviceConfigRepo.findOne({
    where: { deviceId: dto.deviceId },
    relations: ['tenant'],
  });

  if (existingDevice) {
    // Device exists - check if same tenant (building)
    if (existingDevice.tenantId !== setupCode.tenantId) {
      // Different building - reject
      throw new BadRequestException(
        'DEVICE_ALREADY_PAIRED',
        'This device is already paired to another building. Factory reset required.'
      );
    }

    // Same building - allow re-pairing (WiFi change scenario)
    // Update existing config with new WiFi and regenerate MQTT creds
    const mqttCreds = this.generateMqttCredentials(dto.deviceId);

    await this.deviceConfigRepo.update(existingDevice.id, {
      wifiSsid: dto.wifiSsid,
      firmwareVersion: dto.firmwareVersion,
      gateId: setupCode.gateId,
      deviceName: setupCode.deviceName,
      status: 'online',
      lastSeenAt: new Date(),
      ...mqttCreds,
    });

    // Mark setup code as claimed
    await this.setupCodeRepo.update(setupCode.id, {
      status: 'claimed',
      claimedByDeviceId: dto.deviceId,
      claimedAt: new Date(),
    });

    return this.buildClaimResponse(existingDevice, mqttCreds);
  }

  // New device - create config
  const mqttCreds = this.generateMqttCredentials(dto.deviceId);

  const deviceConfig = await this.deviceConfigRepo.save({
    tenantId: setupCode.tenantId,
    gateId: setupCode.gateId,
    deviceName: setupCode.deviceName,
    deviceId: dto.deviceId,
    wifiSsid: dto.wifiSsid,
    firmwareVersion: dto.firmwareVersion,
    setupCodeId: setupCode.id,
    status: 'online',
    lastSeenAt: new Date(),
    ...mqttCreds,
  });

  // Mark setup code as claimed
  await this.setupCodeRepo.update(setupCode.id, {
    status: 'claimed',
    claimedByDeviceId: dto.deviceId,
    claimedAt: new Date(),
  });

  // Update gate with hardware ID
  if (setupCode.gateId) {
    await this.gateRepo.update(setupCode.gateId, {
      hardwareId: dto.deviceId,
    });
  }

  return this.buildClaimResponse(deviceConfig, mqttCreds);
}

private generateMqttCredentials(deviceId: string): MqttCredentials {
  const sanitizedId = deviceId.replace(/:/g, '').toLowerCase();
  return {
    mqttUsername: `device_${sanitizedId}`,
    mqttPassword: crypto.randomBytes(32).toString('base64'),
  };
}
```

---

## Flow 5: Normal Operation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NORMAL OPERATION                                     │
└─────────────────────────────────────────────────────────────────────────────┘

Device boots with valid config:

1. Connect to WiFi
2. Connect to MQTT broker
3. Check for firmware updates (auto-check on boot)
4. Start heartbeat (every 60 seconds)
5. Start normal gate operations (RFID, sensors, etc.)

OLED Display:
┌────────────────────────────┐
│   ░░░░░░░░░░░░░░░░░░░░░░   │
│   ░  GATE READY        ░   │
│   ░                    ░   │
│   ░  Main Entry        ░   │
│   ░  Sunrise Apts      ░   │
│   ░                    ░   │
│   ░  WiFi: ✓  MQTT: ✓  ░   │
│   ░  v1.3.0            ░   │
│   ░░░░░░░░░░░░░░░░░░░░░░   │
└────────────────────────────┘
```

### Heartbeat Mechanism

```cpp
// ESP32 Firmware
#define HEARTBEAT_INTERVAL 60000  // 60 seconds

void sendHeartbeat() {
  StaticJsonDocument<512> doc;
  doc["type"] = "heartbeat";
  doc["firmwareVersion"] = FIRMWARE_VERSION;
  doc["wifiRSSI"] = WiFi.RSSI();
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["uptime"] = millis() / 1000;
  doc["ip"] = WiFi.localIP().toString();

  String payload;
  serializeJson(doc, payload);

  mqttClient.publish(statusTopic, payload.c_str());
}

void loop() {
  // ... other code ...

  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL) {
    sendHeartbeat();
    lastHeartbeat = millis();
  }
}
```

### Backend Heartbeat Handler

```typescript
// mqtt.service.ts
@Injectable()
export class MqttService {

  handleHeartbeat(deviceId: string, payload: HeartbeatPayload) {
    // Update device status
    this.deviceConfigRepo.update(
      { deviceId },
      {
        lastSeenAt: new Date(),
        firmwareVersion: payload.firmwareVersion,
        wifiSignalStrength: payload.wifiRSSI,
        freeHeap: payload.freeHeap,
        uptime: payload.uptime,
        ipAddress: payload.ip,
        status: 'online',
      }
    );

    // Emit WebSocket event
    this.gateway.emitToTenant(device.tenantId, 'device:heartbeat', {
      deviceId,
      status: 'online',
      rssi: payload.wifiRSSI,
    });
  }
}

// Scheduled job to mark offline devices
@Cron('*/30 * * * * *')  // Every 30 seconds
async checkOfflineDevices() {
  const threshold = new Date(Date.now() - 2 * 60 * 1000);  // 2 minutes

  const offlineDevices = await this.deviceConfigRepo.find({
    where: {
      status: 'online',
      lastSeenAt: LessThan(threshold),
    },
  });

  for (const device of offlineDevices) {
    await this.deviceConfigRepo.update(device.id, { status: 'offline' });

    // Emit WebSocket event
    this.gateway.emitToTenant(device.tenantId, 'device:offline', {
      deviceId: device.deviceId,
      lastSeen: device.lastSeenAt,
    });
  }
}
```

---

## Flow 6: Auto-Update Check on Boot

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AUTO-UPDATE CHECK ON BOOT                            │
└─────────────────────────────────────────────────────────────────────────────┘

ESP32 Boot Sequence:
1. Load config from NVS
2. Connect to WiFi
3. Connect to MQTT
4. >>> Check for updates <<<
5. If update available → Download & Apply
6. Start normal operation

```

### Firmware Update Check

```cpp
// ESP32 Firmware
void checkForUpdates() {
  displayMessage("Checking", "for updates...");

  HTTPClient http;
  String url = String(API_BASE_URL) + "/api/v1/devices/check-update";

  http.begin(url);
  http.addHeader("X-Device-ID", WiFi.macAddress());
  http.addHeader("X-Firmware-Version", FIRMWARE_VERSION);

  int httpCode = http.GET();

  if (httpCode == 200) {
    String response = http.getString();
    StaticJsonDocument<512> doc;
    deserializeJson(doc, response);

    bool updateAvailable = doc["updateAvailable"];

    if (updateAvailable) {
      String newVersion = doc["latestVersion"];
      String downloadUrl = doc["downloadUrl"];
      String checksum = doc["checksum"];

      displayMessage("Updating to", "v" + newVersion);

      // Report update starting
      reportOtaStatus("downloading", 0);

      // Perform OTA update
      performOtaUpdate(downloadUrl, checksum, newVersion);
    } else {
      Serial.println("Firmware is up to date");
    }
  }

  http.end();
}

void setup() {
  initHardware();

  if (loadConfig()) {
    if (connectToWiFi()) {
      if (connectToMQTT()) {
        // Check for updates on every boot
        checkForUpdates();

        // Start normal operation
        enterNormalMode();
        return;
      }
    }
  }

  enterSetupMode();
}
```

### Backend Update Check Endpoint

```typescript
// devices.controller.ts
@Get('check-update')
@Public()
async checkUpdate(
  @Headers('X-Device-ID') deviceId: string,
  @Headers('X-Firmware-Version') currentVersion: string,
): Promise<UpdateCheckResponse> {

  const latestFirmware = await this.firmwareService.getLatestStable();

  if (!latestFirmware) {
    return { updateAvailable: false };
  }

  const updateAvailable = this.isNewerVersion(
    latestFirmware.version,
    currentVersion
  );

  if (!updateAvailable) {
    return { updateAvailable: false };
  }

  // Check minimum version requirement
  if (latestFirmware.minRequiredVersion) {
    if (!this.meetsMinVersion(currentVersion, latestFirmware.minRequiredVersion)) {
      // Device needs intermediate update first
      const intermediateVersion = await this.firmwareService.findVersion(
        latestFirmware.minRequiredVersion
      );

      return {
        updateAvailable: true,
        latestVersion: intermediateVersion.version,
        downloadUrl: await this.getSignedUrl(intermediateVersion),
        checksum: intermediateVersion.checksum,
        releaseNotes: intermediateVersion.releaseNotes,
      };
    }
  }

  return {
    updateAvailable: true,
    latestVersion: latestFirmware.version,
    downloadUrl: await this.getSignedUrl(latestFirmware),
    checksum: latestFirmware.checksum,
    releaseNotes: latestFirmware.releaseNotes,
  };
}
```

---

## Flow 7: Offline Mode with Event Queue

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OFFLINE MODE                                         │
└─────────────────────────────────────────────────────────────────────────────┘

WiFi disconnects → Device enters offline mode

OLED Display:
┌────────────────────────────┐
│   ░░░░░░░░░░░░░░░░░░░░░░   │
│   ░  OFFLINE MODE      ░   │
│   ░                    ░   │
│   ░  Gate operational  ░   │
│   ░  Events: 12 queued ░   │
│   ░                    ░   │
│   ░  Reconnecting...   ░   │
│   ░░░░░░░░░░░░░░░░░░░░░░   │
└────────────────────────────┘

Features in offline mode:
─────────────────────────
✓ RFID scanning continues (uses local allowlist)
✓ Gate opens for known RFID cards
✓ Access events queued in NVS (max 100)
✓ Auto-reconnect every 30 seconds
✗ New RFID cards not recognized
✗ Visitor QR codes not validated
✗ Remote gate control not available
```

### Offline Event Queue Implementation

```cpp
// ESP32 Firmware
#include <Preferences.h>

#define MAX_QUEUED_EVENTS 100

struct QueuedEvent {
  char type[20];
  char rfidUid[20];
  char result[20];
  uint32_t timestamp;
};

Preferences eventQueue;
int queuedEventCount = 0;

void queueEvent(const char* type, const char* rfidUid, const char* result) {
  if (queuedEventCount >= MAX_QUEUED_EVENTS) {
    // Queue full - drop oldest event
    shiftQueueLeft();
  }

  eventQueue.begin("events", false);

  String key = "evt_" + String(queuedEventCount);

  StaticJsonDocument<256> doc;
  doc["type"] = type;
  doc["rfidUid"] = rfidUid;
  doc["result"] = result;
  doc["timestamp"] = millis() / 1000;  // Relative timestamp

  String payload;
  serializeJson(doc, payload);

  eventQueue.putString(key.c_str(), payload);
  queuedEventCount++;
  eventQueue.putInt("count", queuedEventCount);

  eventQueue.end();

  updateOledQueueCount();
}

void syncQueuedEvents() {
  if (queuedEventCount == 0) return;

  eventQueue.begin("events", true);

  for (int i = 0; i < queuedEventCount; i++) {
    String key = "evt_" + String(i);
    String payload = eventQueue.getString(key.c_str(), "");

    if (payload.length() > 0) {
      // Publish to MQTT
      String topic = "gate/" + String(deviceId) + "/event/queued";
      mqttClient.publish(topic.c_str(), payload.c_str());
    }
  }

  eventQueue.end();

  // Clear queue after sync
  clearEventQueue();
}

void clearEventQueue() {
  eventQueue.begin("events", false);
  eventQueue.clear();
  queuedEventCount = 0;
  eventQueue.end();
}

// In main loop - check WiFi and sync
void loop() {
  if (WiFi.status() == WL_CONNECTED && mqttClient.connected()) {
    if (wasOffline) {
      // Just reconnected - sync queued events
      syncQueuedEvents();
      wasOffline = false;
      displayNormalMode();
    }
  } else {
    wasOffline = true;
    // Offline - queue events locally
    if (!offlineModeDisplayed) {
      displayOfflineMode();
      offlineModeDisplayed = true;
    }
  }
}
```

---

## Flow 8: Recovery & Reset

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         RECOVERY & RESET                                     │
└─────────────────────────────────────────────────────────────────────────────┘

BOOT Button Actions:
────────────────────

┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   Press & Hold BOOT button:                                              │
│                                                                          │
│   0s ─────── 5s ─────── 8s ─────── 15s ─────────────────────►           │
│   │          │          │          │                                     │
│   │          │          │          └─ 🗑️ FACTORY RESET                   │
│   │          │          │             Both LEDs flash rapidly            │
│   │          │          │             Erases ALL settings                │
│   │          │          │             Returns to first-boot state        │
│   │          │          │             Device can be paired to ANY tenant │
│   │          │          │                                                │
│   │          │          └─ Release now for SETUP MODE                    │
│   │          │             Red LED solid                                 │
│   │          │             Keeps existing tenant association             │
│   │          │             Just re-enter WiFi + new setup code           │
│   │          │                                                           │
│   │          └─ Red LED starts blinking rapidly                          │
│   │             Indicator that action will be taken                      │
│   │                                                                      │
│   └─ Normal boot                                                         │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

Use Cases:
──────────
• WiFi password changed → Hold 5-8s → Re-enter WiFi in portal
• Moving device to different gate → Hold 5-8s → New setup code from admin
• Device needs to go to different building → Hold 15s → Factory reset + new setup
```

---

## Flow 9: OTA Update (Manual Trigger from Dashboard)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MANUAL OTA UPDATE                                    │
└─────────────────────────────────────────────────────────────────────────────┘

Dashboard → Devices → Click "Update" on device

┌─────────────────────────────────────────────────────────────────────────────┐
│  🔧 My Devices                                             [+ Add Device]   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ⚠️ 2 devices have updates available                    [Update All]        │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ 🚪 Main Entry Controller                              🟢 Online        │ │
│  │    Firmware: v1.2.0  ⚠️ Update to v1.3.0 available                     │ │
│  │    Last seen: Just now | Signal: -42 dBm                               │ │
│  │                                                        [Update] [···]  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ 🚪 Parking Gate A                                     🟢 Online        │ │
│  │    Firmware: v1.3.0  ✓ Up to date                                      │ │
│  │    Last seen: 1 min ago | Signal: -55 dBm                              │ │
│  │                                                                 [···]  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

Click "Update" → Confirmation Modal:
┌─────────────────────────────────────────────────────────────────┐
│  🔄 Update Firmware                                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Device: Main Entry Controller                                   │
│  Current: v1.2.0 → New: v1.3.0                                  │
│                                                                  │
│  What's new in v1.3.0:                                          │
│  • Improved RFID reading speed                                   │
│  • Better obstacle detection                                     │
│  • Fixed WiFi reconnection bug                                   │
│                                                                  │
│  ✓ Your settings will be preserved                              │
│  ⚠️ Device will be offline for ~30 seconds during update        │
│                                                                  │
│  [Cancel]                                    [Update Now]        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

During Update:
┌────────────────────────────────────────────────────────────────────────────┐
│ 🚪 Main Entry Controller                              🔄 Updating...       │
│    v1.2.0 → v1.3.0                                                         │
│    ████████████████░░░░░░░░░░ 65%                                          │
│    Status: Downloading firmware...                                         │
└────────────────────────────────────────────────────────────────────────────┘

Completion:
┌────────────────────────────────────────────────────────────────────────────┐
│ 🚪 Main Entry Controller                              🟢 Online            │
│    Firmware: v1.3.0  ✓ Up to date                                          │
│    Last updated: Just now                                                  │
└────────────────────────────────────────────────────────────────────────────┘
```

### OTA via MQTT

```typescript
// devices.service.ts
async triggerOtaUpdate(deviceId: string): Promise<void> {
  const device = await this.deviceConfigRepo.findOne({ where: { id: deviceId } });
  const firmware = await this.firmwareService.getLatestStable();

  // Generate signed download URL (1 hour expiry)
  const downloadUrl = await this.storageService.getSignedUrl(
    firmware.firmwareUrl,
    3600
  );

  // Create update record
  const update = await this.otaUpdateRepo.save({
    deviceConfigId: device.id,
    firmwareVersionId: firmware.id,
    fromVersion: device.firmwareVersion,
    toVersion: firmware.version,
    status: 'pending',
  });

  // Send MQTT command
  await this.mqttService.publish(`gate/${device.deviceId}/ota`, {
    action: 'UPDATE',
    url: downloadUrl,
    version: firmware.version,
    checksum: firmware.checksum,
    updateId: update.id,
  });

  // Update device status
  await this.deviceConfigRepo.update(device.id, { status: 'updating' });

  // Emit WebSocket event
  this.gateway.emitToTenant(device.tenantId, 'device:updating', {
    deviceId: device.deviceId,
    fromVersion: device.firmwareVersion,
    toVersion: firmware.version,
  });
}
```

### Automatic Rollback

```cpp
// ESP32 Firmware - OTA with rollback protection
#include <esp_ota_ops.h>

void performOtaUpdate(String url, String expectedChecksum, String newVersion) {
  WiFiClientSecure client;
  client.setCACertBundle(x509_crt_bundle);

  // Set up progress callback
  httpUpdate.onProgress([](int current, int total) {
    int percent = (current * 100) / total;
    displayProgress(percent);

    if (percent % 10 == 0) {
      reportOtaStatus("downloading", percent);
    }
  });

  t_httpUpdate_return ret = httpUpdate.update(client, url);

  switch (ret) {
    case HTTP_UPDATE_OK:
      reportOtaStatus("installing", 100);
      // Device will reboot automatically
      // On next boot, firmware is in "pending verify" state
      break;

    case HTTP_UPDATE_FAILED:
      reportOtaStatus("failed", 0, httpUpdate.getLastErrorString());
      displayMessage("UPDATE FAILED", httpUpdate.getLastErrorString());
      break;
  }
}

// Called on boot to verify new firmware works
void verifyFirmware() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t ota_state;

  if (esp_ota_get_state_partition(running, &ota_state) == ESP_OK) {
    if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
      // New firmware - need to verify it works
      Serial.println("New firmware - verifying...");

      // Try to connect to WiFi and MQTT
      bool wifiOk = connectToWiFi(30000);  // 30 second timeout
      bool mqttOk = wifiOk && connectToMQTT(10000);  // 10 second timeout

      if (wifiOk && mqttOk) {
        // Success! Mark firmware as valid
        esp_ota_mark_app_valid_cancel_rollback();
        Serial.println("Firmware verified - marked as valid");

        // Report success
        reportOtaStatus("completed", 100);
      } else {
        // Failed to connect - rollback to previous firmware
        Serial.println("Firmware verification failed - rolling back");
        esp_ota_mark_app_invalid_rollback_and_reboot();
        // Device will reboot into previous firmware
      }
    }
  }
}

void setup() {
  initHardware();

  // First thing - verify firmware if it's new
  verifyFirmware();

  // ... rest of setup
}
```

---

## WebSocket Events

```typescript
// gateway.service.ts
@WebSocketGateway()
export class GatewayService {

  // Events emitted to frontend:

  // Device status changes
  'device:online'     // { deviceId, ip, rssi }
  'device:offline'    // { deviceId, lastSeen }
  'device:updating'   // { deviceId, fromVersion, toVersion }
  'device:updated'    // { deviceId, newVersion }

  // OTA progress
  'ota:progress'      // { deviceId, updateId, progress, status }
  'ota:failed'        // { deviceId, updateId, error }
  'ota:completed'     // { deviceId, updateId, newVersion }

  // Firmware releases (to all admins)
  'firmware:available' // { version, releaseNotes }

  // Device heartbeat
  'device:heartbeat'  // { deviceId, rssi, uptime, freeHeap }
}
```

---

## Database Schema (Complete)

```sql
-- Setup codes (temporary pairing tokens)
CREATE TABLE setup_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    gate_id UUID REFERENCES gates(id),

    code VARCHAR(20) NOT NULL UNIQUE,
    device_name VARCHAR(255),

    expires_at TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',  -- pending, claimed, expired

    claimed_by_device_id VARCHAR(20),
    claimed_at TIMESTAMP,

    created_at TIMESTAMP DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE INDEX idx_setup_codes_code ON setup_codes(code);
CREATE INDEX idx_setup_codes_status ON setup_codes(status);

-- Device configurations
CREATE TABLE device_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    gate_id UUID REFERENCES gates(id),

    device_name VARCHAR(255) NOT NULL,
    device_id VARCHAR(20) NOT NULL UNIQUE,  -- MAC address

    setup_code_id UUID REFERENCES setup_codes(id),
    paired_at TIMESTAMP DEFAULT NOW(),

    wifi_ssid VARCHAR(255),

    mqtt_username VARCHAR(255),
    mqtt_password_hash VARCHAR(255),  -- Store hash, not plaintext

    firmware_version VARCHAR(20),

    status VARCHAR(20) DEFAULT 'online',  -- online, offline, updating, setup
    last_seen_at TIMESTAMP,
    ip_address VARCHAR(45),
    wifi_signal_strength INTEGER,
    free_heap INTEGER,
    uptime INTEGER,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    last_reboot_reason VARCHAR(50),

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_device_configs_device_id ON device_configs(device_id);
CREATE INDEX idx_device_configs_tenant ON device_configs(tenant_id);
CREATE INDEX idx_device_configs_status ON device_configs(status);

-- Firmware versions
CREATE TABLE firmware_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version VARCHAR(20) NOT NULL UNIQUE,

    firmware_url TEXT NOT NULL,
    firmware_size INTEGER,
    checksum VARCHAR(64) NOT NULL,

    release_notes TEXT,
    is_stable BOOLEAN DEFAULT FALSE,
    is_latest BOOLEAN DEFAULT FALSE,
    min_required_version VARCHAR(20),
    allow_rollback BOOLEAN DEFAULT TRUE,

    released_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- OTA update history
CREATE TABLE ota_updates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_config_id UUID NOT NULL REFERENCES device_configs(id),
    firmware_version_id UUID NOT NULL REFERENCES firmware_versions(id),

    from_version VARCHAR(20),
    to_version VARCHAR(20) NOT NULL,

    status VARCHAR(20) NOT NULL,  -- pending, downloading, installing, completed, failed, rolled_back
    progress INTEGER DEFAULT 0,
    error_message TEXT,

    initiated_by UUID REFERENCES users(id),  -- NULL if auto-update
    initiated_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX idx_ota_updates_device ON ota_updates(device_config_id);
CREATE INDEX idx_ota_updates_status ON ota_updates(status);

-- Queued events (for offline sync)
CREATE TABLE queued_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_config_id UUID NOT NULL REFERENCES device_configs(id),

    event_type VARCHAR(50) NOT NULL,
    event_data JSONB NOT NULL,
    occurred_at TIMESTAMP NOT NULL,

    synced_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_queued_events_device ON queued_events(device_config_id);
CREATE INDEX idx_queued_events_synced ON queued_events(synced_at);
```

---

## API Endpoints (Complete)

```
SETUP CODES
───────────
POST   /api/v1/devices/setup-codes          Generate new setup code
GET    /api/v1/devices/setup-codes          List active codes for tenant
DELETE /api/v1/devices/setup-codes/:id      Cancel/delete code

DEVICE CLAIM (Public, rate-limited)
───────────────────────────────────
POST   /api/v1/devices/claim                Claim setup code, pair device

DEVICE MANAGEMENT
─────────────────
GET    /api/v1/devices                      List devices for tenant
GET    /api/v1/devices/:id                  Get device details
PATCH  /api/v1/devices/:id                  Update device (name, gate)
DELETE /api/v1/devices/:id                  Unpair/remove device
POST   /api/v1/devices/:id/test             Send test command (beep)

UPDATE CHECK (Public, called by device)
───────────────────────────────────────
GET    /api/v1/devices/check-update         Check for firmware updates
                                            Headers: X-Device-ID, X-Firmware-Version

OTA UPDATES
───────────
GET    /api/v1/devices/:id/firmware         Check update available
POST   /api/v1/devices/:id/firmware/update  Trigger OTA update
GET    /api/v1/devices/:id/firmware/status  Get update progress
POST   /api/v1/devices/bulk-update          Update multiple devices

FIRMWARE MANAGEMENT (Super Admin)
─────────────────────────────────
GET    /api/v1/admin/firmware               List all versions
POST   /api/v1/admin/firmware               Upload new version
GET    /api/v1/admin/firmware/:id           Get version details
PATCH  /api/v1/admin/firmware/:id           Update metadata
POST   /api/v1/admin/firmware/:id/release   Mark as released
DELETE /api/v1/admin/firmware/:id           Delete version

WEBSERIAL FLASH
───────────────
GET    /api/v1/flash/firmware               Get latest firmware binary for flashing
GET    /api/v1/flash/bootloader             Get ESP32 bootloader
GET    /api/v1/flash/partitions             Get partition table
```

---

## Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Database migrations (setup_codes, device_configs, firmware_versions, ota_updates)
- [ ] Setup code generation service
- [ ] Device claim endpoint with rate limiting
- [ ] Basic device CRUD endpoints

### Phase 2: Firmware Core (Week 1-2)
- [ ] Firmware AP mode + captive portal
- [ ] WiFi scanning in captive portal
- [ ] Setup code submission to backend
- [ ] NVS config storage
- [ ] Button hold detection (setup mode, factory reset)

### Phase 3: Dashboard - Devices (Week 2)
- [ ] Device list page with status badges
- [ ] Setup code generation modal
- [ ] Device detail page
- [ ] WebSocket integration for real-time status

### Phase 4: WebSerial Flasher (Week 2)
- [ ] WebSerial flash page in dashboard
- [ ] esptool.js integration
- [ ] Flash progress UI
- [ ] Error handling

### Phase 5: Heartbeat & Status (Week 2-3)
- [ ] Firmware heartbeat every 60 seconds
- [ ] Backend heartbeat handler
- [ ] Offline detection cron job
- [ ] WebSocket events for status changes

### Phase 6: OTA Updates (Week 3)
- [ ] Firmware upload endpoint (super admin)
- [ ] Firmware management UI
- [ ] Update check endpoint
- [ ] Auto-update on boot (firmware)
- [ ] Manual update trigger (dashboard)
- [ ] OTA progress tracking via MQTT
- [ ] Automatic rollback on failure

### Phase 7: Offline Mode (Week 3-4)
- [ ] Event queue in NVS (firmware)
- [ ] Queue sync on reconnect
- [ ] Backend queued events handler
- [ ] Offline mode OLED display

### Phase 8: Polish (Week 4)
- [ ] Error handling throughout
- [ ] Retry mechanisms
- [ ] Logging and diagnostics
- [ ] Testing all scenarios
- [ ] Documentation

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Flash time (WebSerial) | < 60 seconds |
| Setup time (portal) | < 3 minutes |
| First-attempt success rate | > 95% |
| Recovery time (button hold) | < 30 seconds |
| Auto-update check time | < 5 seconds |
| OTA update success rate | > 99% |
| Offline event sync | 100% (up to 100 events) |

---

## Security Checklist

- [x] Setup codes expire after 15 minutes
- [x] Setup codes are single-use
- [x] Rate limiting on claim endpoint (5/min/IP)
- [x] MQTT credentials generated per-device
- [x] Firmware downloads via signed URLs
- [x] OTA checksum verification
- [x] Automatic rollback on failed update
- [x] WiFi passwords stored only on device (NVS)
- [x] WebSerial flasher requires authentication
- [ ] TLS for all communications (MQTT 8883, HTTPS)
- [ ] Signed firmware (future enhancement)
