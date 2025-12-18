/*
 * Gate Management System - ESP32 Controller Firmware
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
 * Communication: MQTT over WiFi
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>

// ==================== CONFIGURATION ====================
// WiFi Settings
const char *WIFI_SSID = "Easital Technologies LTD";
const char *WIFI_PASSWORD = "Easital@2025";

// MQTT Settings
const char *MQTT_BROKER = "192.168.88.2"; // Your server IP
const int MQTT_PORT = 1883;
const char *MQTT_USER = ""; // Leave empty if no auth
const char *MQTT_PASSWORD = "";

// Device ID (unique per gate - will be set from MAC address)
String DEVICE_ID = "";

// Gate Settings
const int SERVO_OPEN_ANGLE = 90;             // Angle when gate is open
const int SERVO_CLOSE_ANGLE = 0;             // Angle when gate is closed
const int SERVO_SPEED_DELAY = 15;            // ms between angle steps (lower = faster)
const unsigned long AUTO_CLOSE_DELAY = 5000; // Auto-close after 5 seconds

// Ultrasonic sensor threshold (cm)
const int OBSTACLE_DISTANCE_CM = 30; // Object closer than this = obstacle

// ==================== PIN DEFINITIONS ====================
// Based on your exact wiring

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
#define RFID_SS 5
#define RFID_RST 16

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

// ==================== OBJECTS ====================
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
MFRC522 rfid(RFID_SS, RFID_RST);
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
Servo gateServo;

// ==================== STATE VARIABLES ====================
enum GateState
{
  CLOSED,
  OPENING,
  OPEN,
  CLOSING,
  OBSTACLE_HOLD,
  FAULT,
  MANUAL_OVERRIDE
};

GateState currentState = CLOSED;
GateState previousState = CLOSED;
int currentServoAngle = SERVO_CLOSE_ANGLE;
unsigned long lastHeartbeat = 0;
unsigned long autoCloseTimer = 0;
bool obstacleDetected = false;
unsigned long lastRfidRead = 0;
const unsigned long RFID_DEBOUNCE = 2000; // Prevent multiple reads
unsigned long lastUltrasonicRead = 0;
const unsigned long ULTRASONIC_INTERVAL = 100; // Read every 100ms

// MQTT Topics
String topicStatus;
String topicCommand;
String topicEvent;
String topicDisplay;
String topicFeedback;

// ==================== SETUP ====================
void setup()
{
  Serial.begin(115200);
  Serial.println("\n\n=== Gate Controller Starting ===");

  // Initialize pins
  pinMode(IR_SENSOR_PIN, INPUT);
  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_GREEN_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);

  // Initial LED state
  digitalWrite(LED_GREEN_PIN, LOW);
  digitalWrite(LED_RED_PIN, HIGH); // Red on during startup
  digitalWrite(ULTRASONIC_TRIG, LOW);

  // Initialize I2C for OLED with custom pins
  Wire.begin(OLED_SDA, OLED_SCL);

  // Initialize OLED
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C))
  {
    Serial.println("SSD1306 OLED failed!");
  }
  else
  {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println("Gate Controller");
    display.println("Starting...");
    display.display();
    Serial.println("OLED initialized");
  }

  // Initialize SPI for RFID
  SPI.begin(RFID_SCK, RFID_MISO, RFID_MOSI, RFID_SS);
  rfid.PCD_Init();
  delay(100);

  // Check RFID reader
  byte version = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  if (version == 0x00 || version == 0xFF)
  {
    Serial.println("WARNING: RFID reader not detected!");
    showDisplay("RFID Error", "Check wiring");
    delay(2000);
  }
  else
  {
    Serial.print("RFID reader initialized, version: 0x");
    Serial.println(version, HEX);
  }

  // Initialize Servo
  ESP32PWM::allocateTimer(0);
  gateServo.setPeriodHertz(50);
  gateServo.attach(SERVO_PIN, 500, 2400);
  gateServo.write(SERVO_CLOSE_ANGLE);
  currentServoAngle = SERVO_CLOSE_ANGLE;
  Serial.println("Servo initialized on GPIO" + String(SERVO_PIN));

  // Get device ID from MAC address
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char macStr[13];
  sprintf(macStr, "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  DEVICE_ID = String(macStr);
  Serial.println("Device ID: " + DEVICE_ID);

  // Setup MQTT topics
  topicStatus = "gate/" + DEVICE_ID + "/status";
  topicCommand = "gate/" + DEVICE_ID + "/command";
  topicEvent = "gate/" + DEVICE_ID + "/event";
  topicDisplay = "gate/" + DEVICE_ID + "/display";
  topicFeedback = "gate/" + DEVICE_ID + "/feedback";

  // Connect to WiFi
  connectWiFi();

  // Setup MQTT
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(512);

  // Connect to MQTT
  connectMQTT();

  // Ready
  digitalWrite(LED_RED_PIN, LOW);
  digitalWrite(LED_GREEN_PIN, HIGH);
  beep(2, 100);

  showDisplay("Ready", "Scan RFID");
  Serial.println("=== Gate Controller Ready ===\n");
  Serial.println("Pin Configuration:");
  Serial.println("  OLED: SDA=" + String(OLED_SDA) + ", SCL=" + String(OLED_SCL));
  Serial.println("  RFID: SS=" + String(RFID_SS) + ", RST=" + String(RFID_RST));
  Serial.println("  Servo: " + String(SERVO_PIN));
  Serial.println("  IR: " + String(IR_SENSOR_PIN));
  Serial.println("  Ultrasonic: TRIG=" + String(ULTRASONIC_TRIG) + ", ECHO=" + String(ULTRASONIC_ECHO));
  Serial.println("  LEDs: Green=" + String(LED_GREEN_PIN) + ", Red=" + String(LED_RED_PIN));
  Serial.println("  Buzzer: " + String(BUZZER_PIN));
}

// ==================== MAIN LOOP ====================
void loop()
{
  // Maintain connections
  if (WiFi.status() != WL_CONNECTED)
  {
    connectWiFi();
  }

  if (!mqtt.connected())
  {
    connectMQTT();
  }
  mqtt.loop();

  // Read sensors
  checkRfid();
  checkObstacleSensors();

  // Handle gate state machine
  handleGateStateMachine();

  // Send heartbeat every 10 seconds
  if (millis() - lastHeartbeat > 10000)
  {
    sendHeartbeat();
    lastHeartbeat = millis();
  }

  // Auto-close timer
  if (currentState == OPEN && autoCloseTimer > 0 && millis() > autoCloseTimer)
  {
    Serial.println("Auto-close triggered");
    closeGate();
    autoCloseTimer = 0;
  }
}

// ==================== WIFI CONNECTION ====================
void connectWiFi()
{
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);
  showDisplay("Connecting", "WiFi...");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30)
  {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED)
  {
    Serial.println("\nWiFi connected!");
    Serial.println("IP: " + WiFi.localIP().toString());
    showDisplay("WiFi OK", WiFi.localIP().toString().c_str());
  }
  else
  {
    Serial.println("\nWiFi connection failed!");
    showDisplay("WiFi FAIL", "Check config");
  }
}

// ==================== MQTT CONNECTION ====================
void connectMQTT()
{
  Serial.print("Connecting to MQTT: ");
  Serial.println(MQTT_BROKER);
  showDisplay("Connecting", "MQTT...");

  int attempts = 0;
  while (!mqtt.connected() && attempts < 5)
  {
    String clientId = "gate-" + DEVICE_ID;

    bool connected;
    if (strlen(MQTT_USER) > 0)
    {
      connected = mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASSWORD);
    }
    else
    {
      connected = mqtt.connect(clientId.c_str());
    }

    if (connected)
    {
      Serial.println("MQTT connected!");

      // Subscribe to command topics
      mqtt.subscribe(topicCommand.c_str());
      mqtt.subscribe(topicDisplay.c_str());
      mqtt.subscribe(topicFeedback.c_str());

      Serial.println("Subscribed to topics:");
      Serial.println("  " + topicCommand);
      Serial.println("  " + topicDisplay);
      Serial.println("  " + topicFeedback);

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
void mqttCallback(char *topic, byte *payload, unsigned int length)
{
  String topicStr = String(topic);
  String payloadStr = "";
  for (unsigned int i = 0; i < length; i++)
  {
    payloadStr += (char)payload[i];
  }

  Serial.println("MQTT RX: " + topicStr);
  Serial.println("  Data: " + payloadStr);

  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, payloadStr);
  if (error)
  {
    Serial.println("JSON parse error: " + String(error.c_str()));
    return;
  }

  if (topicStr == topicCommand)
  {
    handleCommand(doc);
  }
  else if (topicStr == topicDisplay)
  {
    handleDisplayMessage(doc);
  }
  else if (topicStr == topicFeedback)
  {
    handleFeedback(doc);
  }
}

// ==================== COMMAND HANDLER ====================
void handleCommand(JsonDocument &doc)
{
  String command = doc["command"].as<String>();
  Serial.println("Command received: " + command);

  if (command == "OPEN")
  {
    openGate();
  }
  else if (command == "CLOSE")
  {
    closeGate();
  }
  else if (command == "STOP")
  {
    stopGate();
  }
  else if (command == "STATUS")
  {
    sendHeartbeat();
  }
}

void handleDisplayMessage(JsonDocument &doc)
{
  String line1 = doc["line1"].as<String>();
  String line2 = doc["line2"].as<String>();
  Serial.println("Display: " + line1 + " / " + line2);
  showDisplay(line1.c_str(), line2.c_str());
}

void handleFeedback(JsonDocument &doc)
{
  String type = doc["type"].as<String>();
  bool beepEnabled = doc["beep"] | true;
  Serial.println("Feedback: " + type);

  if (type == "SUCCESS")
  {
    digitalWrite(LED_GREEN_PIN, HIGH);
    digitalWrite(LED_RED_PIN, LOW);
    if (beepEnabled)
      beep(1, 200);
  }
  else if (type == "ERROR")
  {
    digitalWrite(LED_GREEN_PIN, LOW);
    digitalWrite(LED_RED_PIN, HIGH);
    if (beepEnabled)
      beep(3, 100);
  }
  else if (type == "WARNING")
  {
    digitalWrite(LED_GREEN_PIN, HIGH);
    digitalWrite(LED_RED_PIN, HIGH);
    if (beepEnabled)
      beep(2, 150);
  }
}

// ==================== RFID READING ====================
void checkRfid()
{
  // Debounce
  if (millis() - lastRfidRead < RFID_DEBOUNCE)
  {
    return;
  }

  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial())
  {
    return;
  }

  // Read UID
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++)
  {
    if (rfid.uid.uidByte[i] < 0x10)
      uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();

  Serial.println("*** RFID Card Detected ***");
  Serial.println("  UID: " + uid);
  lastRfidRead = millis();

  // Visual feedback
  beep(1, 50);
  showDisplay("Card Read", uid.c_str());

  // Send to server for validation
  sendRfidEvent(uid, "vehicle");

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

// ==================== OBSTACLE SENSORS ====================
void checkObstacleSensors()
{
  // Check IR sensor
  bool irObstacle = digitalRead(IR_SENSOR_PIN) == LOW; // LOW = obstacle detected

  // Check ultrasonic sensor periodically
  bool ultrasonicObstacle = false;
  if (millis() - lastUltrasonicRead > ULTRASONIC_INTERVAL)
  {
    float distance = readUltrasonicDistance();
    lastUltrasonicRead = millis();

    if (distance > 0 && distance < OBSTACLE_DISTANCE_CM)
    {
      ultrasonicObstacle = true;
      Serial.println("Ultrasonic: " + String(distance) + " cm - OBSTACLE");
    }
  }

  // Combined obstacle detection (either sensor)
  bool obstacle = irObstacle || ultrasonicObstacle;

  if (obstacle != obstacleDetected)
  {
    obstacleDetected = obstacle;

    if (obstacleDetected)
    {
      Serial.println("!!! Obstacle detected !!!");
      sendEvent("OBSTACLE_DETECTED");

      if (currentState == CLOSING)
      {
        currentState = OBSTACLE_HOLD;
        showDisplay("OBSTACLE", "Gate Stopped");
        beep(3, 100);
      }
    }
    else
    {
      Serial.println("Obstacle cleared");
      sendEvent("OBSTACLE_CLEARED");

      if (currentState == OBSTACLE_HOLD)
      {
        closeGate(); // Resume closing
      }
    }
  }
}

// ==================== ULTRASONIC SENSOR ====================
float readUltrasonicDistance()
{
  // Send trigger pulse
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  // Read echo pulse
  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 30000); // 30ms timeout

  if (duration == 0)
  {
    return -1; // No echo received
  }

  // Calculate distance (speed of sound = 343m/s = 0.0343 cm/µs)
  // Distance = (duration * 0.0343) / 2
  float distance = duration * 0.0343 / 2.0;

  return distance;
}

// ==================== GATE STATE MACHINE ====================
void handleGateStateMachine()
{
  static unsigned long lastServoMove = 0;

  if (millis() - lastServoMove < SERVO_SPEED_DELAY)
  {
    return;
  }

  switch (currentState)
  {
  case OPENING:
    if (currentServoAngle < SERVO_OPEN_ANGLE)
    {
      currentServoAngle++;
      gateServo.write(currentServoAngle);
      lastServoMove = millis();
    }
    else
    {
      // Reached open position
      currentState = OPEN;
      showDisplay("OPEN", "Gate Open");
      autoCloseTimer = millis() + AUTO_CLOSE_DELAY;
      Serial.println("Gate fully open");
    }
    break;

  case CLOSING:
    if (currentServoAngle > SERVO_CLOSE_ANGLE)
    {
      currentServoAngle--;
      gateServo.write(currentServoAngle);
      lastServoMove = millis();
    }
    else
    {
      // Reached closed position
      currentState = CLOSED;
      showDisplay("CLOSED", "Scan RFID");
      Serial.println("Gate fully closed");
    }
    break;

  case OBSTACLE_HOLD:
    // Waiting for obstacle to clear
    break;

  default:
    break;
  }

  // Broadcast state changes
  if (currentState != previousState)
  {
    sendStateChange();
    previousState = currentState;
  }
}

// ==================== GATE COMMANDS ====================
void openGate()
{
  Serial.println(">>> Opening gate...");
  currentState = OPENING;
  showDisplay("OPENING", "Please wait...");
  digitalWrite(LED_GREEN_PIN, HIGH);
  digitalWrite(LED_RED_PIN, LOW);
}

void closeGate()
{
  Serial.println(">>> Closing gate...");
  currentState = CLOSING;
  showDisplay("CLOSING", "Please wait...");
  digitalWrite(LED_GREEN_PIN, LOW);
  digitalWrite(LED_RED_PIN, HIGH);
}

void stopGate()
{
  Serial.println(">>> Stopping gate!");
  previousState = currentState;
  currentState = MANUAL_OVERRIDE;
  showDisplay("STOPPED", "Manual mode");
  beep(1, 500);
}

// ==================== MQTT PUBLISHING ====================
void sendHeartbeat()
{
  StaticJsonDocument<256> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["macAddress"] = WiFi.macAddress();
  doc["firmwareVersion"] = "1.0.0";
  doc["wifiStrength"] = WiFi.RSSI();
  doc["uptimeSeconds"] = millis() / 1000;
  doc["gateState"] = getStateString(currentState);
  doc["isOnline"] = true;

  String payload;
  serializeJson(doc, payload);
  mqtt.publish(topicStatus.c_str(), payload.c_str());
  Serial.println("Heartbeat sent");
}

void sendRfidEvent(String uid, String type)
{
  StaticJsonDocument<256> doc;
  doc["event"] = "RFID_SCAN";
  doc["deviceId"] = DEVICE_ID;
  doc["rfidUid"] = uid;
  doc["type"] = type;
  doc["timestamp"] = millis();

  String payload;
  serializeJson(doc, payload);
  mqtt.publish(topicEvent.c_str(), payload.c_str());
  Serial.println("RFID event sent: " + uid);
}

void sendEvent(String eventType)
{
  StaticJsonDocument<128> doc;
  doc["event"] = eventType;
  doc["deviceId"] = DEVICE_ID;
  doc["timestamp"] = millis();

  String payload;
  serializeJson(doc, payload);
  mqtt.publish(topicEvent.c_str(), payload.c_str());
  Serial.println("Event sent: " + eventType);
}

void sendStateChange()
{
  StaticJsonDocument<128> doc;
  doc["event"] = "STATE_CHANGE";
  doc["deviceId"] = DEVICE_ID;
  doc["state"] = getStateString(currentState);
  doc["previousState"] = getStateString(previousState);
  doc["timestamp"] = millis();

  String payload;
  serializeJson(doc, payload);
  mqtt.publish(topicEvent.c_str(), payload.c_str());
  Serial.println("State change: " + getStateString(previousState) + " -> " + getStateString(currentState));
}

// ==================== DISPLAY ====================
void showDisplay(const char *line1, const char *line2)
{
  display.clearDisplay();
  display.setTextSize(2);
  display.setCursor(0, 0);
  display.println(line1);
  display.setTextSize(1);
  display.setCursor(0, 24);
  display.println(line2);

  // Show status bar
  display.drawLine(0, 40, 128, 40, SSD1306_WHITE);
  display.setCursor(0, 45);
  display.print("WiFi:");
  display.print(WiFi.status() == WL_CONNECTED ? "OK" : "X");
  display.print(" MQTT:");
  display.print(mqtt.connected() ? "OK" : "X");
  display.setCursor(0, 55);
  display.print("ID:");
  display.print(DEVICE_ID);

  display.display();
}

// ==================== BUZZER ====================
void beep(int count, int duration)
{
  for (int i = 0; i < count; i++)
  {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(duration);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < count - 1)
      delay(duration);
  }
}

// ==================== UTILITIES ====================
String getStateString(GateState state)
{
  switch (state)
  {
  case CLOSED:
    return "CLOSED";
  case OPENING:
    return "OPENING";
  case OPEN:
    return "OPEN";
  case CLOSING:
    return "CLOSING";
  case OBSTACLE_HOLD:
    return "OBSTACLE_HOLD";
  case FAULT:
    return "FAULT";
  case MANUAL_OVERRIDE:
    return "MANUAL_OVERRIDE";
  default:
    return "UNKNOWN";
  }
}
