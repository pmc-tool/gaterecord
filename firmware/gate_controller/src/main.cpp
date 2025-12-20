/*
 * Gate Management System - ESP32 Controller Firmware
 * Version: 2.0.0 - With Captive Portal Setup & OTA
 *
 * Hardware: ESP32 DevKit V1
 * Components:
 *   - MFRC522 RFID Reader (SPI)
 *   - SG90 Servo Motor (PWM)
 *   - SSD1306 OLED Display (I2C)
 *   - IR Obstacle Sensor
 *   - HC-SR04 Ultrasonic Sensor
 *   - Buzzer + LEDs
 *
 * Features:
 *   - Captive portal for WiFi setup
 *   - Setup code claiming
 *   - NVS credential storage
 *   - MQTT communication
 *   - OTA updates
 */

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <Update.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>

// ==================== FIRMWARE VERSION ====================
const char *FIRMWARE_VERSION = "2.0.0";

// ==================== PIN DEFINITIONS ====================
// OLED Display (I2C)
#define OLED_SDA 26
#define OLED_SCL 27
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1

// RFID RC522 (SPI)
#define RFID_SCK 18
#define RFID_MISO 19
#define RFID_MOSI 23
#define RFID_SS 4
#define RFID_RST 17

// Servo Motor
#define SERVO_PIN 14

// IR Obstacle Sensor
#define IR_SENSOR_PIN 34

// Ultrasonic HC-SR04
#define ULTRASONIC_TRIG 32
#define ULTRASONIC_ECHO 33

// Buzzer
#define BUZZER_PIN 25

// LEDs
#define LED_GREEN_PIN 13
#define LED_RED_PIN 12

// Setup Button (for entering setup mode)
#define SETUP_BUTTON_PIN 0  // BOOT button on most ESP32 boards

// ==================== GATE SETTINGS ====================
const int SERVO_OPEN_ANGLE = 90;
const int SERVO_CLOSE_ANGLE = 0;
const int SERVO_SPEED_DELAY = 15;
const unsigned long AUTO_CLOSE_DELAY = 5000;
const int OBSTACLE_DISTANCE_CM = 15;
const int OBSTACLE_DEBOUNCE_COUNT = 3;
const bool IR_SENSOR_ENABLED = true;
const bool ULTRASONIC_ENABLED = true;

// ==================== TIMING ====================
const unsigned long HEARTBEAT_INTERVAL = 60000;  // 60 seconds
const unsigned long UPDATE_CHECK_INTERVAL = 300000;  // 5 minutes
const unsigned long SETUP_TIMEOUT = 300000;  // 5 minutes for setup mode

// ==================== OBJECTS ====================
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
WebServer webServer(80);
DNSServer dnsServer;
Preferences preferences;
MFRC522 rfid(RFID_SS, RFID_RST);
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
Servo gateServo;

// ==================== STATE VARIABLES ====================
enum DeviceMode {
  MODE_SETUP,
  MODE_NORMAL
};

enum GateState {
  CLOSED,
  OPENING,
  OPEN,
  CLOSING,
  OBSTACLE_HOLD,
  FAULT,
  MANUAL_OVERRIDE
};

DeviceMode currentMode = MODE_SETUP;
GateState currentState = CLOSED;
GateState previousState = CLOSED;
int currentServoAngle = SERVO_CLOSE_ANGLE;

// Stored configuration
String storedWifiSsid = "";
String storedWifiPassword = "";
String storedMqttBroker = "";
int storedMqttPort = 1883;
String storedMqttUsername = "";
String storedMqttPassword = "";
String storedApiBaseUrl = "";
String storedTenantId = "";
String storedGateId = "";

// Device ID (MAC address based)
String DEVICE_ID = "";

// MQTT Topics
String topicStatus;
String topicCommand;
String topicEvent;
String topicDisplay;
String topicFeedback;
String topicAlarm;
String topicOta;

// Timing
unsigned long lastHeartbeat = 0;
unsigned long autoCloseTimer = 0;
unsigned long lastRfidRead = 0;
unsigned long lastUltrasonicRead = 0;
unsigned long lastUpdateCheck = 0;
unsigned long setupModeStartTime = 0;

// Obstacle tracking
int obstacleDetectedCount = 0;
int obstacleClearedCount = 0;
bool obstacleDetected = false;

// Alarm state
bool alarmActive = false;
unsigned long lastAlarmBeep = 0;

// Setup mode
bool setupModeActive = false;
unsigned long buttonPressStart = 0;
String lastClaimError = "Setup failed";

// Setup progress tracking for captive portal
volatile int setupStep = 0;  // 0=WiFi, 1=Server, 2=Config, 3=Done
volatile bool setupDone = false;
volatile bool setupError = false;
String setupStatus = "Ready";

// ==================== FORWARD DECLARATIONS ====================
void enterSetupMode();
void enterNormalMode();
void handleSetupMode();
void handleNormalMode();
void setupCaptivePortal();
void handleCaptivePortalRoot();
void handleCaptivePortalSetup();
void handleCaptivePortalClaim();
bool claimSetupCode(const String &code, const String &ssid, const String &password, const String &serverUrl);
void saveCredentials();
void loadCredentials();
void clearCredentials();
void connectWiFi();
void connectMQTT();
void mqttCallback(char *topic, byte *payload, unsigned int length);
void handleCommand(JsonDocument &doc);
void handleDisplayMessage(JsonDocument &doc);
void handleFeedback(JsonDocument &doc);
void handleAlarm(JsonDocument &doc);
void handleOtaCommand(JsonDocument &doc);
void checkRfid();
void checkObstacleSensors();
float readUltrasonicDistance();
void handleGateStateMachine();
void openGate();
void closeGate();
void stopGate();
void sendHeartbeat();
void sendRfidEvent(String uid, String type);
void sendEvent(String eventType);
void sendStateChange();
void showDisplay(const char *line1, const char *line2);
void beep(int count, int duration);
String getStateString(GateState state);
void checkForUpdates();
void performOtaUpdate(const String &url, const String &checksum);
void checkSetupButton();
void initHardware();
void initRfid();

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);
  Serial.println("\n\n=== Gate Controller Starting ===");
  Serial.print("Firmware Version: ");
  Serial.println(FIRMWARE_VERSION);

  // Get device ID from MAC address
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char macStr[18];
  sprintf(macStr, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  DEVICE_ID = String(macStr);
  Serial.println("Device ID: " + DEVICE_ID);

  // Initialize hardware
  initHardware();

  // Load stored credentials
  loadCredentials();

  // Check if we have valid credentials
  if (storedWifiSsid.length() > 0 && storedMqttBroker.length() > 0) {
    Serial.println("Found stored credentials, entering normal mode");
    currentMode = MODE_NORMAL;
    enterNormalMode();
  } else {
    Serial.println("No stored credentials, entering setup mode");
    currentMode = MODE_SETUP;
    enterSetupMode();
  }
}

// ==================== MAIN LOOP ====================
void loop() {
  // Check for setup button press (long press to enter setup mode)
  checkSetupButton();

  if (currentMode == MODE_SETUP) {
    handleSetupMode();
  } else {
    handleNormalMode();
  }
}

// ==================== HARDWARE INITIALIZATION ====================
void initHardware() {
  // Initialize pins
  pinMode(IR_SENSOR_PIN, INPUT);
  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_GREEN_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);
  pinMode(SETUP_BUTTON_PIN, INPUT_PULLUP);

  digitalWrite(LED_GREEN_PIN, LOW);
  digitalWrite(LED_RED_PIN, HIGH);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  // Initialize I2C for OLED
  Wire.begin(OLED_SDA, OLED_SCL);

  // Initialize OLED
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 OLED failed!");
  } else {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println("Gate Controller");
    display.println(FIRMWARE_VERSION);
    display.display();
    Serial.println("OLED initialized");
  }

  // Initialize Servo
  ESP32PWM::allocateTimer(0);
  gateServo.setPeriodHertz(50);
  gateServo.attach(SERVO_PIN, 500, 2400);
  gateServo.write(SERVO_CLOSE_ANGLE);
  currentServoAngle = SERVO_CLOSE_ANGLE;
  Serial.println("Servo initialized");
}

void initRfid() {
  // Initialize SPI for RFID
  SPI.begin(RFID_SCK, RFID_MISO, RFID_MOSI);
  pinMode(RFID_SS, OUTPUT);
  digitalWrite(RFID_SS, HIGH);
  pinMode(RFID_RST, OUTPUT);

  // Hard reset
  digitalWrite(RFID_RST, LOW);
  delay(100);
  digitalWrite(RFID_RST, HIGH);
  delay(100);

  rfid.PCD_Init();
  delay(100);

  byte version = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  if (version != 0x00 && version != 0xFF) {
    rfid.PCD_AntennaOn();
    rfid.PCD_SetAntennaGain(rfid.RxGain_max);
    Serial.println("RFID initialized, version: 0x" + String(version, HEX));
  } else {
    Serial.println("WARNING: RFID reader not detected!");
  }
}

// ==================== SETUP MODE ====================
void enterSetupMode() {
  Serial.println("Entering setup mode...");
  setupModeActive = true;
  setupModeStartTime = millis();

  // Disconnect from any WiFi
  WiFi.disconnect(true);
  delay(100);

  // Start captive portal
  setupCaptivePortal();

  showDisplay("Setup Mode", "Connect to WiFi:");
  delay(1000);

  // Show AP name
  String apName = "Gate-Setup-" + DEVICE_ID.substring(9, 17);
  apName.replace(":", "");
  showDisplay("WiFi:", apName.c_str());

  digitalWrite(LED_RED_PIN, LOW);
  digitalWrite(LED_GREEN_PIN, LOW);
  beep(3, 100);
}

void handleSetupMode() {
  dnsServer.processNextRequest();
  webServer.handleClient();

  // Blink LEDs in setup mode
  static unsigned long lastBlink = 0;
  if (millis() - lastBlink > 500) {
    digitalWrite(LED_GREEN_PIN, !digitalRead(LED_GREEN_PIN));
    digitalWrite(LED_RED_PIN, !digitalRead(LED_RED_PIN));
    lastBlink = millis();
  }

  // Check for timeout
  if (millis() - setupModeStartTime > SETUP_TIMEOUT) {
    Serial.println("Setup mode timeout");
    if (storedWifiSsid.length() > 0) {
      // Have credentials, try normal mode
      setupModeActive = false;
      currentMode = MODE_NORMAL;
      webServer.stop();
      WiFi.softAPdisconnect(true);
      enterNormalMode();
    }
  }
}

void setupCaptivePortal() {
  // Create AP name from device ID
  String apName = "Gate-Setup-" + DEVICE_ID.substring(9, 17);
  apName.replace(":", "");

  Serial.println("Starting AP: " + apName);
  WiFi.mode(WIFI_AP);
  WiFi.softAP(apName.c_str());

  IPAddress apIP = WiFi.softAPIP();
  Serial.println("AP IP: " + apIP.toString());

  // Start DNS server for captive portal
  dnsServer.start(53, "*", apIP);

  // Setup web server routes
  webServer.on("/", HTTP_GET, handleCaptivePortalRoot);
  webServer.on("/setup", HTTP_POST, handleCaptivePortalSetup);
  webServer.on("/setup-status", HTTP_GET, []() {
    String json = "{\"step\":" + String(setupStep) +
                  ",\"status\":\"" + setupStatus + "\"" +
                  ",\"done\":" + (setupDone ? "true" : "false") +
                  ",\"error\":" + (setupError ? "\"" + lastClaimError + "\"" : "null") + "}";
    webServer.send(200, "application/json", json);
  });
  webServer.on("/generate_204", HTTP_GET, handleCaptivePortalRoot);  // Android
  webServer.on("/fwlink", HTTP_GET, handleCaptivePortalRoot);  // Windows
  webServer.onNotFound(handleCaptivePortalRoot);

  webServer.begin();
  Serial.println("Captive portal started");
}

void handleCaptivePortalRoot() {
  String html = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gate Setup</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
    .container { max-width: 420px; margin: 0 auto; background: white; padding: 24px; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
    h1 { color: #333; text-align: center; margin: 0 0 8px 0; font-size: 24px; }
    .subtitle { text-align: center; color: #666; font-size: 14px; margin-bottom: 16px; }
    .device-id { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px; border-radius: 8px; text-align: center; font-family: monospace; font-size: 14px; margin-bottom: 20px; }
    input { width: 100%; padding: 14px; margin: 6px 0; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; transition: border-color 0.2s; }
    input:focus { outline: none; border-color: #667eea; }
    button { width: 100%; padding: 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 16px; transition: transform 0.2s, box-shadow 0.2s; }
    button:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(102,126,234,0.4); }
    button:disabled { opacity: 0.7; cursor: not-allowed; transform: none; }
    label { display: block; margin-top: 12px; color: #444; font-weight: 500; font-size: 14px; }
    .hint { font-size: 12px; color: #888; margin-top: 4px; }

    /* Loader Section */
    #loaderSection { display: none; text-align: center; padding: 40px 20px; }
    .spinner { width: 60px; height: 60px; border: 4px solid #e0e0e0; border-top: 4px solid #667eea; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .loader-text { font-size: 18px; color: #333; font-weight: 600; margin-bottom: 8px; }
    .loader-hint { font-size: 14px; color: #666; }

    /* Result Section */
    #resultSection { display: none; text-align: center; padding: 40px 20px; }
    .result-icon { width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; font-size: 40px; }
    .result-icon.success { background: #e8f5e9; color: #4CAF50; }
    .result-icon.error { background: #ffebee; color: #f44336; }
    .result-title { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
    .result-title.success { color: #2e7d32; }
    .result-title.error { color: #c62828; }
    .result-msg { font-size: 14px; color: #666; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Gate Setup</h1>
    <p class="subtitle">Configure your gate controller</p>
    <div class="device-id">)rawliteral" + DEVICE_ID + R"rawliteral(</div>

    <div id="formSection">
      <form id="setupForm">
        <label>Setup Code</label>
        <input type="text" id="code" name="code" placeholder="XXX-XXX-XXX" required maxlength="11">
        <div class="hint">Get this from your dashboard</div>

        <label>Server URL</label>
        <input type="text" id="server" name="server" placeholder="http://192.168.1.100:3001" required>

        <label>WiFi Network</label>
        <input type="text" id="ssid" name="ssid" placeholder="Your WiFi name" required>

        <label>WiFi Password</label>
        <input type="password" id="password" name="password" placeholder="WiFi password">

        <button type="submit" id="submitBtn">Connect</button>
      </form>
    </div>

    <div id="loaderSection">
      <div class="spinner"></div>
      <div class="loader-text">Setting up your gate...</div>
      <div class="loader-hint">This may take up to 30 seconds</div>
    </div>

    <div id="resultSection">
      <div class="result-icon" id="resultIcon"></div>
      <div class="result-title" id="resultTitle"></div>
      <div class="result-msg" id="resultMsg"></div>
      <button id="retryBtn" style="display:none; margin-top:20px;" onclick="location.reload()">Try Again</button>
    </div>
  </div>

  <script>
    function showLoader() {
      document.getElementById('formSection').style.display = 'none';
      document.getElementById('loaderSection').style.display = 'block';
      document.getElementById('resultSection').style.display = 'none';
    }

    function showSuccess() {
      document.getElementById('formSection').style.display = 'none';
      document.getElementById('loaderSection').style.display = 'none';
      document.getElementById('resultSection').style.display = 'block';
      document.getElementById('resultIcon').className = 'result-icon success';
      document.getElementById('resultIcon').textContent = '✓';
      document.getElementById('resultTitle').className = 'result-title success';
      document.getElementById('resultTitle').textContent = 'Setup Complete!';
      document.getElementById('resultMsg').innerHTML = 'Your gate is configured and ready!<br><br><b>You can now close this page</b> and connect back to your home WiFi.';
      document.getElementById('retryBtn').textContent = 'Close';
      document.getElementById('retryBtn').style.display = 'block';
      document.getElementById('retryBtn').onclick = function() {
        window.close();
        // Fallback for browsers that block window.close()
        setTimeout(function() {
          document.body.innerHTML = '<div style="text-align:center;padding:50px;font-family:sans-serif;"><h2>✓ Setup Complete!</h2><p>Please close this tab manually.</p></div>';
        }, 500);
      };
    }

    function showError(msg) {
      document.getElementById('formSection').style.display = 'none';
      document.getElementById('loaderSection').style.display = 'none';
      document.getElementById('resultSection').style.display = 'block';
      document.getElementById('resultIcon').className = 'result-icon error';
      document.getElementById('resultIcon').textContent = '✗';
      document.getElementById('resultTitle').className = 'result-title error';
      document.getElementById('resultTitle').textContent = 'Setup Failed';
      document.getElementById('resultMsg').textContent = msg;
      document.getElementById('retryBtn').style.display = 'block';
    }

    document.getElementById('setupForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      showLoader();

      const data = new FormData(this);
      try {
        const response = await fetch('/setup', {
          method: 'POST',
          body: new URLSearchParams(data)
        });
        const result = await response.json();
        if (result.success) {
          showSuccess();
        } else {
          showError(result.error || 'Setup failed. Please try again.');
        }
      } catch (err) {
        // Connection lost - check if setup succeeded via polling
        let retries = 0;
        const checkStatus = async () => {
          try {
            const r = await fetch('/setup-status');
            const s = await r.json();
            if (s.done) { showSuccess(); return; }
            if (s.error) { showError(s.error); return; }
          } catch(e) { /* ignore */ }
          retries++;
          if (retries < 6) setTimeout(checkStatus, 1000);
          else showSuccess(); // Assume success if AP stopped (normal behavior)
        };
        setTimeout(checkStatus, 1000);
      }
    });

    document.getElementById('code').addEventListener('input', function(e) {
      let v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      v = v.slice(0, 9);
      if (v.length > 6) v = v.slice(0,3) + '-' + v.slice(3,6) + '-' + v.slice(6);
      else if (v.length > 3) v = v.slice(0,3) + '-' + v.slice(3);
      e.target.value = v;
    });
  </script>
</body>
</html>
)rawliteral";

  webServer.send(200, "text/html", html);
}

void handleCaptivePortalSetup() {
  // Reset progress state
  setupStep = 0;
  setupDone = false;
  setupError = false;
  setupStatus = "Starting";

  String code = webServer.arg("code");
  String serverUrl = webServer.arg("server");
  String ssid = webServer.arg("ssid");
  String password = webServer.arg("password");

  Serial.println("Setup request received");
  Serial.println("Code: " + code);
  Serial.println("Server: " + serverUrl);
  Serial.println("SSID: " + ssid);

  // Format code properly
  code.toUpperCase();

  // Validate server URL
  if (!serverUrl.startsWith("http://") && !serverUrl.startsWith("https://")) {
    serverUrl = "http://" + serverUrl;
  }
  // Remove trailing slash
  if (serverUrl.endsWith("/")) {
    serverUrl = serverUrl.substring(0, serverUrl.length() - 1);
  }

  // Step 0: Connecting to WiFi
  setupStep = 0;
  setupStatus = "WiFi";
  showDisplay("Connecting...", ssid.c_str());

  // Use AP+STA mode to keep captive portal responsive during setup
  WiFi.mode(WIFI_AP_STA);
  WiFi.begin(ssid.c_str(), password.c_str());

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\nWiFi connection failed!");
    showDisplay("WiFi Failed", "Check credentials");
    setupError = true;
    lastClaimError = "WiFi connection failed";
    webServer.send(200, "application/json", "{\"success\":false,\"error\":\"WiFi connection failed. Check credentials.\"}");
    return;
  }

  Serial.println("\nWiFi connected!");
  Serial.println("IP: " + WiFi.localIP().toString());
  Serial.println("Gateway: " + WiFi.gatewayIP().toString());

  // Step 1: Contacting server
  setupStep = 1;
  setupStatus = "Server";
  showDisplay("WiFi OK", "Reaching server...");

  // Wait for network to stabilize in AP+STA mode
  delay(2000);

  // Step 2: Configuring device (claim the setup code)
  setupStep = 2;
  setupStatus = "Config";

  // Try to claim - if fails due to routing, retry after stopping AP
  bool claimed = claimSetupCode(code, ssid, password, serverUrl);

  if (!claimed && lastClaimError.startsWith("Conn:")) {
    // Routing issue - stop AP and retry
    Serial.println("Routing issue detected, stopping AP and retrying...");
    setupStatus = "Retry";
    showDisplay("Retrying...", "Fixing network");

    WiFi.softAPdisconnect(true);
    delay(500);
    WiFi.mode(WIFI_STA);
    delay(2000);

    Serial.println("Retry - IP: " + WiFi.localIP().toString());
    claimed = claimSetupCode(code, ssid, password, serverUrl);
  }

  if (claimed) {
    // Step 3: Done!
    setupStep = 3;
    setupStatus = "Done";
    setupDone = true;

    // Send success response BEFORE stopping AP
    webServer.send(200, "application/json", "{\"success\":true,\"message\":\"Setup complete! Device is now configured.\"}");

    showDisplay("Success!", "Starting...");
    Serial.println("Setup successful, keeping AP alive for phone to see success...");

    // Keep AP running for 3 seconds so phone can display success
    for (int i = 0; i < 30; i++) {
      webServer.handleClient();
      dnsServer.processNextRequest();
      delay(100);
    }

    Serial.println("Transitioning to normal mode...");

    // Now stop the captive portal
    webServer.stop();
    dnsServer.stop();
    WiFi.softAPdisconnect(true);
    delay(500);

    // Switch to pure STA mode
    WiFi.mode(WIFI_STA);
    delay(500);

    setupModeActive = false;
    currentMode = MODE_NORMAL;
    enterNormalMode();
  } else {
    setupError = true;
    setupStatus = "Failed";
    showDisplay("Claim Failed", lastClaimError.substring(0, 16).c_str());
    String errorResponse = "{\"success\":false,\"error\":\"" + lastClaimError + "\"}";
    webServer.send(200, "application/json", errorResponse);
  }
}

bool claimSetupCode(const String &code, const String &ssid, const String &password, const String &serverUrl) {
  String apiUrl = serverUrl + "/api/v1/devices/claim";

  // Debug network info
  Serial.println("=== Network Debug ===");
  Serial.println("ESP32 IP: " + WiFi.localIP().toString());
  Serial.println("Gateway: " + WiFi.gatewayIP().toString());
  Serial.println("DNS: " + WiFi.dnsIP().toString());
  Serial.println("Subnet: " + WiFi.subnetMask().toString());
  Serial.println("Target URL: " + apiUrl);
  Serial.println("WiFi RSSI: " + String(WiFi.RSSI()));
  Serial.println("WiFi Status: " + String(WiFi.status()));
  Serial.println("====================");

  // Parse host and port from serverUrl for connectivity test
  String host = serverUrl;
  int port = 80;

  // Remove protocol
  if (host.startsWith("http://")) {
    host = host.substring(7);
  } else if (host.startsWith("https://")) {
    host = host.substring(8);
    port = 443;
  }

  // Extract port if present
  int colonIdx = host.indexOf(':');
  if (colonIdx > 0) {
    port = host.substring(colonIdx + 1).toInt();
    host = host.substring(0, colonIdx);
  }

  // Remove path
  int slashIdx = host.indexOf('/');
  if (slashIdx > 0) {
    host = host.substring(0, slashIdx);
  }

  Serial.println("=== TCP Connectivity Test ===");
  Serial.println("Testing connection to: " + host + ":" + String(port));

  WiFiClient testClient;
  testClient.setTimeout(5000);

  if (testClient.connect(host.c_str(), port)) {
    Serial.println("TCP connection successful!");
    testClient.stop();
  } else {
    Serial.println("TCP connection FAILED!");
    Serial.println("Cannot reach server - check network/firewall");
  }
  Serial.println("=============================");

  HTTPClient http;
  http.setTimeout(10000);  // 10 second timeout
  http.begin(apiUrl);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<256> doc;
  doc["code"] = code;
  doc["deviceId"] = DEVICE_ID;
  doc["firmwareVersion"] = FIRMWARE_VERSION;
  doc["wifiSsid"] = ssid;

  String payload;
  serializeJson(doc, payload);

  Serial.println("Claiming setup code...");
  Serial.println("URL: " + apiUrl);
  Serial.println("Payload: " + payload);

  int httpCode = http.POST(payload);

  // Accept both 200 (OK) and 201 (Created) as success
  if (httpCode == 200 || httpCode == 201) {
    String response = http.getString();
    Serial.println("Claim response: " + response);

    StaticJsonDocument<512> responseDoc;
    DeserializationError error = deserializeJson(responseDoc, response);

    if (!error && responseDoc["success"] == true) {
      JsonObject config = responseDoc["config"];

      // Store credentials
      storedWifiSsid = ssid;
      storedWifiPassword = password;
      storedMqttBroker = config["mqttBroker"].as<String>();
      storedMqttPort = config["mqttPort"] | 1883;
      storedMqttUsername = config["mqttUsername"].as<String>();
      storedMqttPassword = config["mqttPassword"].as<String>();
      // Use apiBaseUrl from response, fallback to serverUrl if not provided
      storedApiBaseUrl = config["apiBaseUrl"].as<String>();
      if (storedApiBaseUrl.length() == 0) {
        storedApiBaseUrl = serverUrl;
      }
      storedTenantId = config["tenantId"].as<String>();
      storedGateId = config["gateId"].as<String>();

      saveCredentials();

      Serial.println("Setup code claimed successfully!");
      showDisplay("Success!", "Restarting...");
      return true;
    } else {
      // Extract error message from backend response
      lastClaimError = responseDoc["message"].as<String>();
      if (lastClaimError.length() == 0) {
        lastClaimError = responseDoc["error"].as<String>();
      }
      if (lastClaimError.length() == 0) {
        lastClaimError = "Setup code invalid";
      }
      Serial.println("Claim failed: " + lastClaimError);
    }
  } else if (httpCode > 0) {
    lastClaimError = "Server error: " + String(httpCode);
    Serial.println("HTTP error: " + String(httpCode));
  } else {
    // httpCode is negative - connection error
    String errorMsg = http.errorToString(httpCode);
    lastClaimError = "Conn: " + errorMsg;
    Serial.println("Connection failed: " + errorMsg + " (code: " + String(httpCode) + ")");
  }

  http.end();
  return false;
}

// ==================== CREDENTIAL STORAGE ====================
void saveCredentials() {
  preferences.begin("gate", false);
  preferences.putString("wifi_ssid", storedWifiSsid);
  preferences.putString("wifi_pass", storedWifiPassword);
  preferences.putString("mqtt_broker", storedMqttBroker);
  preferences.putInt("mqtt_port", storedMqttPort);
  preferences.putString("mqtt_user", storedMqttUsername);
  preferences.putString("mqtt_pass", storedMqttPassword);
  preferences.putString("api_url", storedApiBaseUrl);
  preferences.putString("tenant_id", storedTenantId);
  preferences.putString("gate_id", storedGateId);
  preferences.end();
  Serial.println("Credentials saved to NVS");
}

void loadCredentials() {
  preferences.begin("gate", true);
  storedWifiSsid = preferences.getString("wifi_ssid", "");
  storedWifiPassword = preferences.getString("wifi_pass", "");
  storedMqttBroker = preferences.getString("mqtt_broker", "");
  storedMqttPort = preferences.getInt("mqtt_port", 1883);
  storedMqttUsername = preferences.getString("mqtt_user", "");
  storedMqttPassword = preferences.getString("mqtt_pass", "");
  storedApiBaseUrl = preferences.getString("api_url", "");
  storedTenantId = preferences.getString("tenant_id", "");
  storedGateId = preferences.getString("gate_id", "");
  preferences.end();

  Serial.println("Loaded credentials:");
  Serial.println("  WiFi SSID: " + storedWifiSsid);
  Serial.println("  MQTT Broker: " + storedMqttBroker);
  Serial.println("  Tenant ID: " + storedTenantId);
}

void clearCredentials() {
  preferences.begin("gate", false);
  preferences.clear();
  preferences.end();

  storedWifiSsid = "";
  storedWifiPassword = "";
  storedMqttBroker = "";
  storedMqttPort = 1883;
  storedMqttUsername = "";
  storedMqttPassword = "";
  storedApiBaseUrl = "";
  storedTenantId = "";
  storedGateId = "";

  Serial.println("Credentials cleared");
}

// ==================== SETUP BUTTON ====================
void checkSetupButton() {
  static bool buttonPressed = false;

  if (digitalRead(SETUP_BUTTON_PIN) == LOW) {
    if (!buttonPressed) {
      buttonPressed = true;
      buttonPressStart = millis();
    } else {
      unsigned long pressDuration = millis() - buttonPressStart;

      // 5-8 seconds: enter setup mode
      if (pressDuration >= 5000 && pressDuration < 8000 && currentMode == MODE_NORMAL) {
        Serial.println("Long press detected - entering setup mode");
        beep(2, 200);
        currentMode = MODE_SETUP;
        enterSetupMode();
        buttonPressed = false;
      }
      // 15+ seconds: factory reset
      else if (pressDuration >= 15000) {
        Serial.println("Very long press detected - factory reset");
        beep(5, 100);
        clearCredentials();
        showDisplay("Factory Reset", "Restarting...");
        delay(2000);
        ESP.restart();
      }
    }
  } else {
    buttonPressed = false;
  }
}

// ==================== NORMAL MODE ====================
void enterNormalMode() {
  Serial.println("Entering normal mode...");

  // Initialize RFID (not needed during setup)
  initRfid();

  // Setup MQTT topics
  String deviceIdClean = DEVICE_ID;
  deviceIdClean.replace(":", "");
  topicStatus = "gate/" + deviceIdClean + "/status";
  topicCommand = "gate/" + deviceIdClean + "/command";
  topicEvent = "gate/" + deviceIdClean + "/event";
  topicDisplay = "gate/" + deviceIdClean + "/display";
  topicFeedback = "gate/" + deviceIdClean + "/feedback";
  topicAlarm = "gate/" + deviceIdClean + "/alarm";
  topicOta = "gate/" + deviceIdClean + "/ota";

  // Connect to WiFi
  connectWiFi();

  // Setup MQTT
  mqtt.setServer(storedMqttBroker.c_str(), storedMqttPort);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(1024);

  // Connect to MQTT
  connectMQTT();

  // Check for updates on boot
  checkForUpdates();

  // Ready
  digitalWrite(LED_RED_PIN, LOW);
  digitalWrite(LED_GREEN_PIN, HIGH);
  beep(2, 100);
  showDisplay("Ready", "Scan RFID");
}

void handleNormalMode() {
  // Maintain connections
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (!mqtt.connected()) {
    connectMQTT();
  }
  mqtt.loop();

  // Read sensors
  checkRfid();
  checkObstacleSensors();

  // Handle gate state machine
  handleGateStateMachine();

  // Send heartbeat
  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL) {
    sendHeartbeat();
    lastHeartbeat = millis();
  }

  // Check for updates periodically
  if (millis() - lastUpdateCheck > UPDATE_CHECK_INTERVAL) {
    checkForUpdates();
    lastUpdateCheck = millis();
  }

  // Auto-close timer
  if (currentState == OPEN && autoCloseTimer > 0 && millis() > autoCloseTimer) {
    Serial.println("Auto-close triggered");
    closeGate();
    autoCloseTimer = 0;
  }

  // Security alarm beeping
  if (alarmActive) {
    if (millis() - lastAlarmBeep > 500) {
      static bool buzzerState = false;
      buzzerState = !buzzerState;
      digitalWrite(BUZZER_PIN, buzzerState ? HIGH : LOW);
      static bool ledFlash = false;
      ledFlash = !ledFlash;
      digitalWrite(LED_RED_PIN, ledFlash ? HIGH : LOW);
      lastAlarmBeep = millis();
    }
  }
}

// ==================== WIFI CONNECTION ====================
void connectWiFi() {
  Serial.print("Connecting to WiFi: ");
  Serial.println(storedWifiSsid);
  showDisplay("Connecting", "WiFi...");

  WiFi.mode(WIFI_STA);
  WiFi.begin(storedWifiSsid.c_str(), storedWifiPassword.c_str());

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected!");
    Serial.println("IP: " + WiFi.localIP().toString());
    showDisplay("WiFi OK", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWiFi connection failed!");
    showDisplay("WiFi FAIL", "Check config");
  }
}

// ==================== MQTT CONNECTION ====================
void connectMQTT() {
  Serial.print("Connecting to MQTT: ");
  Serial.println(storedMqttBroker);
  showDisplay("Connecting", "MQTT...");

  int attempts = 0;
  while (!mqtt.connected() && attempts < 5) {
    String clientId = "gate-" + DEVICE_ID;
    clientId.replace(":", "");

    bool connected;
    if (storedMqttUsername.length() > 0) {
      connected = mqtt.connect(clientId.c_str(), storedMqttUsername.c_str(), storedMqttPassword.c_str());
    } else {
      connected = mqtt.connect(clientId.c_str());
    }

    if (connected) {
      Serial.println("MQTT connected!");

      // Subscribe to topics
      mqtt.subscribe(topicCommand.c_str());
      mqtt.subscribe(topicDisplay.c_str());
      mqtt.subscribe(topicFeedback.c_str());
      mqtt.subscribe(topicAlarm.c_str());
      mqtt.subscribe(topicOta.c_str());

      Serial.println("Subscribed to topics");
      showDisplay("MQTT OK", "Ready");
      sendHeartbeat();
      return;
    }

    Serial.print(".");
    attempts++;
    delay(1000);
  }

  Serial.println("MQTT connection failed!");
  showDisplay("MQTT FAIL", "Retrying...");
}

// ==================== MQTT CALLBACK ====================
void mqttCallback(char *topic, byte *payload, unsigned int length) {
  String topicStr = String(topic);
  String payloadStr = "";
  for (unsigned int i = 0; i < length; i++) {
    payloadStr += (char)payload[i];
  }

  Serial.println("MQTT RX: " + topicStr);
  Serial.println("  Data: " + payloadStr);

  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, payloadStr);
  if (error) {
    Serial.println("JSON parse error: " + String(error.c_str()));
    return;
  }

  if (topicStr == topicCommand) {
    handleCommand(doc);
  } else if (topicStr == topicDisplay) {
    handleDisplayMessage(doc);
  } else if (topicStr == topicFeedback) {
    handleFeedback(doc);
  } else if (topicStr == topicAlarm) {
    handleAlarm(doc);
  } else if (topicStr == topicOta) {
    handleOtaCommand(doc);
  }
}

// ==================== COMMAND HANDLERS ====================
void handleCommand(JsonDocument &doc) {
  String command = doc["command"].as<String>();
  Serial.println("Command received: " + command);

  if (command == "OPEN") {
    openGate();
  } else if (command == "CLOSE") {
    closeGate();
  } else if (command == "STOP") {
    stopGate();
  } else if (command == "STATUS") {
    sendHeartbeat();
  } else if (command == "TEST") {
    beep(3, 100);
    showDisplay("Test OK", DEVICE_ID.c_str());
  }
}

void handleDisplayMessage(JsonDocument &doc) {
  String line1 = doc["line1"].as<String>();
  String line2 = doc["line2"].as<String>();
  showDisplay(line1.c_str(), line2.c_str());
}

void handleFeedback(JsonDocument &doc) {
  String type = doc["type"].as<String>();
  bool beepEnabled = doc["beep"] | true;

  if (type == "SUCCESS") {
    digitalWrite(LED_GREEN_PIN, HIGH);
    digitalWrite(LED_RED_PIN, LOW);
    if (beepEnabled) beep(1, 200);
  } else if (type == "ERROR") {
    digitalWrite(LED_GREEN_PIN, LOW);
    digitalWrite(LED_RED_PIN, HIGH);
    if (beepEnabled) beep(3, 100);
  } else if (type == "WARNING") {
    digitalWrite(LED_GREEN_PIN, HIGH);
    digitalWrite(LED_RED_PIN, HIGH);
    if (beepEnabled) beep(2, 150);
  }
}

void handleAlarm(JsonDocument &doc) {
  String action = doc["action"].as<String>();
  String alertId = doc["alertId"].as<String>();

  if (action == "START") {
    alarmActive = true;
    lastAlarmBeep = 0;
    showDisplay("!! ALARM !!", "SECURITY ALERT");
    digitalWrite(LED_RED_PIN, HIGH);
    digitalWrite(LED_GREEN_PIN, LOW);
  } else if (action == "STOP") {
    alarmActive = false;
    digitalWrite(BUZZER_PIN, LOW);
    showDisplay("Alarm Off", "Scan RFID");
    digitalWrite(LED_RED_PIN, LOW);
    digitalWrite(LED_GREEN_PIN, HIGH);
  }
}

void handleOtaCommand(JsonDocument &doc) {
  String action = doc["action"].as<String>();

  if (action == "UPDATE") {
    String url = doc["url"].as<String>();
    String checksum = doc["checksum"].as<String>();
    String version = doc["version"].as<String>();

    Serial.println("OTA update requested to version " + version);
    showDisplay("Updating...", version.c_str());

    performOtaUpdate(url, checksum);
  }
}

// ==================== OTA UPDATE ====================
void checkForUpdates() {
  if (storedApiBaseUrl.length() == 0) return;

  String url = storedApiBaseUrl + "/api/v1/devices/check-update";

  HTTPClient http;
  http.begin(url);
  http.addHeader("X-Device-ID", DEVICE_ID);
  http.addHeader("X-Firmware-Version", FIRMWARE_VERSION);

  int httpCode = http.GET();

  if (httpCode == 200) {
    String response = http.getString();
    Serial.println("Update check response: " + response);

    StaticJsonDocument<512> doc;
    deserializeJson(doc, response);

    if (doc["updateAvailable"] == true) {
      String latestVersion = doc["latestVersion"].as<String>();
      String downloadUrl = doc["downloadUrl"].as<String>();
      String checksum = doc["checksum"].as<String>();

      Serial.println("Update available: " + latestVersion);
      // Don't auto-update, wait for manual trigger or MQTT command
    }
  }

  http.end();
}

void performOtaUpdate(const String &url, const String &checksum) {
  HTTPClient http;
  http.begin(url);

  int httpCode = http.GET();

  if (httpCode == 200) {
    int contentLength = http.getSize();

    if (contentLength > 0) {
      bool canBegin = Update.begin(contentLength);

      if (canBegin) {
        WiFiClient *stream = http.getStreamPtr();
        size_t written = Update.writeStream(*stream);

        if (written == contentLength) {
          Serial.println("OTA written successfully");
        }

        if (Update.end()) {
          if (Update.isFinished()) {
            Serial.println("OTA update successful, restarting...");
            showDisplay("Update OK", "Restarting...");
            delay(1000);
            ESP.restart();
          }
        } else {
          Serial.println("OTA error: " + String(Update.getError()));
          showDisplay("Update Failed", "Error");
        }
      }
    }
  } else {
    Serial.println("OTA download failed: " + String(httpCode));
    showDisplay("Download Failed", String(httpCode).c_str());
  }

  http.end();
}

// ==================== HEARTBEAT ====================
void sendHeartbeat() {
  StaticJsonDocument<256> doc;
  doc["type"] = "heartbeat";
  doc["firmwareVersion"] = FIRMWARE_VERSION;
  doc["wifiStrength"] = WiFi.RSSI();
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["uptimeSeconds"] = millis() / 1000;
  doc["ipAddress"] = WiFi.localIP().toString();
  doc["gateState"] = "CLOSED";  // TODO: track actual state
  doc["isOnline"] = true;

  String payload;
  serializeJson(doc, payload);
  mqtt.publish(topicStatus.c_str(), payload.c_str());
  Serial.println("Heartbeat sent");
}

// ==================== RFID ====================
void checkRfid() {
  if (millis() - lastRfidRead < 2000) return;

  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();

  Serial.println("RFID: " + uid);
  lastRfidRead = millis();

  beep(1, 50);
  showDisplay("Card Read", uid.c_str());
  sendRfidEvent(uid, "vehicle");

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

// ==================== OBSTACLE SENSORS ====================
void checkObstacleSensors() {
  if (currentState != OPENING && currentState != CLOSING && currentState != OBSTACLE_HOLD) {
    return;
  }

  bool irObstacle = false;
  bool ultrasonicObstacle = false;

  if (IR_SENSOR_ENABLED) {
    irObstacle = digitalRead(IR_SENSOR_PIN) == LOW;
  }

  if (ULTRASONIC_ENABLED && millis() - lastUltrasonicRead > 100) {
    float distance = readUltrasonicDistance();
    lastUltrasonicRead = millis();
    if (distance > 0 && distance < OBSTACLE_DISTANCE_CM) {
      ultrasonicObstacle = true;
    }
  }

  bool currentReading = irObstacle || ultrasonicObstacle;

  if (currentReading && !obstacleDetected) {
    obstacleDetectedCount++;
    obstacleClearedCount = 0;
    if (obstacleDetectedCount >= OBSTACLE_DEBOUNCE_COUNT) {
      obstacleDetected = true;
      obstacleDetectedCount = 0;
      sendEvent("OBSTACLE_DETECTED");
      if (currentState == CLOSING) {
        currentState = OBSTACLE_HOLD;
        showDisplay("OBSTACLE", "Gate Stopped");
        beep(3, 100);
      }
    }
  } else if (!currentReading && obstacleDetected) {
    obstacleClearedCount++;
    obstacleDetectedCount = 0;
    if (obstacleClearedCount >= OBSTACLE_DEBOUNCE_COUNT) {
      obstacleDetected = false;
      obstacleClearedCount = 0;
      sendEvent("OBSTACLE_CLEARED");
      if (currentState == OBSTACLE_HOLD) {
        closeGate();
      }
    }
  }
}

float readUltrasonicDistance() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 30000);
  if (duration == 0) return -1;
  return duration * 0.0343 / 2.0;
}

// ==================== GATE STATE MACHINE ====================
void handleGateStateMachine() {
  static unsigned long lastServoMove = 0;
  if (millis() - lastServoMove < SERVO_SPEED_DELAY) return;

  switch (currentState) {
    case OPENING:
      if (currentServoAngle < SERVO_OPEN_ANGLE) {
        currentServoAngle++;
        gateServo.write(currentServoAngle);
        lastServoMove = millis();
      } else {
        currentState = OPEN;
        showDisplay("OPEN", "Gate Open");
        autoCloseTimer = millis() + AUTO_CLOSE_DELAY;
      }
      break;

    case CLOSING:
      if (currentServoAngle > SERVO_CLOSE_ANGLE) {
        currentServoAngle--;
        gateServo.write(currentServoAngle);
        lastServoMove = millis();
      } else {
        currentState = CLOSED;
        showDisplay("CLOSED", "Scan RFID");
      }
      break;

    default:
      break;
  }

  if (currentState != previousState) {
    sendStateChange();
    previousState = currentState;
  }
}

// ==================== GATE COMMANDS ====================
void openGate() {
  currentState = OPENING;
  showDisplay("OPENING", "Please wait...");
  digitalWrite(LED_GREEN_PIN, HIGH);
  digitalWrite(LED_RED_PIN, LOW);
}

void closeGate() {
  currentState = CLOSING;
  showDisplay("CLOSING", "Please wait...");
  digitalWrite(LED_GREEN_PIN, LOW);
  digitalWrite(LED_RED_PIN, HIGH);
}

void stopGate() {
  previousState = currentState;
  currentState = MANUAL_OVERRIDE;
  showDisplay("STOPPED", "Manual mode");
  beep(1, 500);
}

// ==================== MQTT PUBLISHING ====================
void sendRfidEvent(String uid, String type) {
  StaticJsonDocument<256> doc;
  doc["event"] = "RFID_SCAN";
  doc["deviceId"] = DEVICE_ID;
  doc["rfidUid"] = uid;
  doc["type"] = type;
  doc["timestamp"] = millis();

  String payload;
  serializeJson(doc, payload);
  mqtt.publish(topicEvent.c_str(), payload.c_str());
}

void sendEvent(String eventType) {
  StaticJsonDocument<128> doc;
  doc["event"] = eventType;
  doc["deviceId"] = DEVICE_ID;
  doc["timestamp"] = millis();

  String payload;
  serializeJson(doc, payload);
  mqtt.publish(topicEvent.c_str(), payload.c_str());
}

void sendStateChange() {
  StaticJsonDocument<128> doc;
  doc["event"] = "STATE_CHANGE";
  doc["deviceId"] = DEVICE_ID;
  doc["state"] = getStateString(currentState);
  doc["previousState"] = getStateString(previousState);
  doc["timestamp"] = millis();

  String payload;
  serializeJson(doc, payload);
  mqtt.publish(topicEvent.c_str(), payload.c_str());
}

// ==================== DISPLAY ====================
void showDisplay(const char *line1, const char *line2) {
  display.clearDisplay();
  display.setTextSize(2);
  display.setCursor(0, 0);
  display.println(line1);
  display.setTextSize(1);
  display.setCursor(0, 24);
  display.println(line2);

  display.drawLine(0, 40, 128, 40, SSD1306_WHITE);
  display.setCursor(0, 45);
  display.print("WiFi:");
  display.print(WiFi.status() == WL_CONNECTED ? "OK" : "X");
  display.print(" MQTT:");
  display.print(mqtt.connected() ? "OK" : "X");
  display.setCursor(0, 55);
  display.print("v");
  display.print(FIRMWARE_VERSION);

  display.display();
}

// ==================== BUZZER ====================
void beep(int count, int duration) {
  for (int i = 0; i < count; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(duration);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < count - 1) delay(duration);
  }
}

// ==================== UTILITIES ====================
String getStateString(GateState state) {
  switch (state) {
    case CLOSED: return "CLOSED";
    case OPENING: return "OPENING";
    case OPEN: return "OPEN";
    case CLOSING: return "CLOSING";
    case OBSTACLE_HOLD: return "OBSTACLE_HOLD";
    case FAULT: return "FAULT";
    case MANUAL_OVERRIDE: return "MANUAL_OVERRIDE";
    default: return "UNKNOWN";
  }
}
