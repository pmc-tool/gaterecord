# Gate Controller ESP32 Firmware

## Hardware Requirements

- ESP32 DevKit V1 (USB Type-C)
- MFRC522 RFID Reader (13.56MHz)
- SG90 Servo Motor
- SSD1306 OLED 0.96" I2C Display
- IR Obstacle Sensor
- HC-SR04 Ultrasonic Sensor
- Buzzer Module
- Green LED + Red LED (with 220 ohm resistors)
- 5V 3A Power Adapter
- 1000uF Capacitor (for servo)
- Level Shifter for HC-SR04 Echo (5V to 3.3V)

## Wiring Diagram

```
ESP32 DevKit V1 Pin Connections
================================

OLED Display (I2C):
  SDA  -> GPIO26
  SCL  -> GPIO27
  VCC  -> 3.3V
  GND  -> GND

RFID RC522 (SPI):
  SDA/CS -> GPIO5
  SCK    -> GPIO18
  MOSI   -> GPIO23
  MISO   -> GPIO19
  RST    -> GPIO16
  VCC    -> 3.3V
  GND    -> GND
  IRQ    -> NC (not connected)

Servo Motor (SG90):
  Signal -> GPIO14
  VCC    -> 5V (from adapter, NOT ESP32!)
  GND    -> Common GND

IR Obstacle Sensor:
  OUT -> GPIO34
  VCC -> 3.3V
  GND -> GND

Ultrasonic HC-SR04:
  TRIG -> GPIO32
  ECHO -> GPIO33 (via level shifter 5V->3.3V!)
  VCC  -> 5V
  GND  -> GND

Buzzer:
  Signal -> GPIO25
  VCC    -> 5V or 3.3V (depends on module)
  GND    -> GND

LEDs (with 220 ohm resistors to GND):
  Green -> GPIO13
  Red   -> GPIO12
```

## Important Notes

1. **Ultrasonic Echo Pin**: The HC-SR04 outputs 5V on the ECHO pin. Use a voltage divider or level shifter to convert to 3.3V before connecting to GPIO33.

2. **Servo Power**: Never power the servo from ESP32's 5V pin. Use an external 5V power supply with common GND.

3. **Common GND**: All modules must share a common ground with the ESP32.

## Software Setup

### PlatformIO (Recommended)

1. Install VS Code with PlatformIO extension
2. Open this folder as a project
3. PlatformIO will automatically install dependencies from `platformio.ini`
4. Connect ESP32 via USB
5. Click Upload (arrow button)

### Arduino IDE

1. Install Arduino IDE 2.x
2. Add ESP32 board support:
   - File -> Preferences -> Additional Board Manager URLs:
   - `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
3. Tools -> Board -> Boards Manager -> Search "ESP32" -> Install
4. Install libraries (Tools -> Manage Libraries):
   - `MFRC522` by GithubCommunity
   - `Adafruit SSD1306`
   - `Adafruit GFX Library`
   - `ESP32Servo`
   - `PubSubClient` by Nick O'Leary
   - `ArduinoJson` by Benoit Blanchon

## Configuration

Edit these lines in `gate_controller.ino`:

```cpp
// WiFi Settings
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// MQTT Settings
const char* MQTT_BROKER = "YOUR_SERVER_IP";  // e.g., "192.168.1.100"
const int MQTT_PORT = 1883;
```

## MQTT Topics

The device uses these MQTT topics (where `{DEVICE_ID}` is the ESP32 MAC address):

| Topic | Direction | Description |
|-------|-----------|-------------|
| `gate/{DEVICE_ID}/status` | Device -> Server | Heartbeat with device status |
| `gate/{DEVICE_ID}/event` | Device -> Server | RFID scans, state changes, sensor events |
| `gate/{DEVICE_ID}/command` | Server -> Device | Open/Close/Stop commands |
| `gate/{DEVICE_ID}/display` | Server -> Device | Display messages |
| `gate/{DEVICE_ID}/feedback` | Server -> Device | LED/Buzzer feedback |

## Message Formats

### Status (Device -> Server)
```json
{
  "deviceId": "AABBCCDDEEFF",
  "macAddress": "AA:BB:CC:DD:EE:FF",
  "firmwareVersion": "1.0.0",
  "wifiStrength": -65,
  "uptimeSeconds": 3600,
  "gateState": "CLOSED",
  "isOnline": true
}
```

### RFID Event (Device -> Server)
```json
{
  "event": "RFID_SCAN",
  "deviceId": "AABBCCDDEEFF",
  "rfidUid": "A1B2C3D4",
  "type": "vehicle",
  "timestamp": 12345678
}
```

### Command (Server -> Device)
```json
{
  "command": "OPEN",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

### Display Message (Server -> Device)
```json
{
  "line1": "Welcome",
  "line2": "John Doe",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

### Feedback (Server -> Device)
```json
{
  "type": "SUCCESS",
  "beep": true,
  "timestamp": "2024-01-01T12:00:00Z"
}
```

## Registering the Device

After flashing, the device will display its Device ID (MAC address) on the OLED.

1. Note the Device ID (e.g., `AABBCCDDEEFF`)
2. In the web app, go to Gates management
3. Edit the gate and enter the Device ID in the "Hardware ID" field
4. Save - the gate is now linked to the physical device

## Troubleshooting

### RFID not reading
- Check SPI wiring carefully
- Ensure 3.3V power (NOT 5V!)
- Try different RFID cards/tags
- Check Serial Monitor for "RFID reader initialized" message

### Servo jittering
- Add 1000uF capacitor across 5V and GND near servo
- Use external 5V power, not ESP32's 5V pin

### WiFi not connecting
- Check SSID and password
- Ensure 2.4GHz network (ESP32 doesn't support 5GHz)
- Check signal strength

### MQTT not connecting
- Verify broker IP address
- Check if Mosquitto is running: `mosquitto_sub -t "#" -v`
- Check firewall allows port 1883

### OLED not displaying
- Check I2C address (default 0x3C, some are 0x3D)
- Verify SDA/SCL wiring
- Check 3.3V power

### Ultrasonic sensor not working
- Verify level shifter on ECHO pin
- Check 5V power supply
- Ensure TRIG and ECHO aren't swapped
