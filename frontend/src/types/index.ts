// User types
export enum UserRole {
  SUPER_ADMIN = 'super_admin',
  BUILDING_ADMIN = 'building_admin',
  SECURITY = 'security',
  RESIDENT = 'resident',
  STAFF = 'staff',
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  PENDING = 'pending',
}

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: UserRole;
  status: UserStatus;
  tenantId?: string;
  unit?: string;
  createdAt: string;
  updatedAt: string;
}

// Tenant types
export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  TRIAL = 'trial',
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  contactEmail: string;
  contactPhone?: string;
  address?: string;
  status: TenantStatus;
  subscriptionPlanId: string;
  subscriptionExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  maxGates: number;
  maxUsers: number;
  logRetentionDays: number;
  features: {
    simulator_access?: boolean;
    csv_export?: boolean;
    api_access?: boolean;
    custom_branding?: boolean;
  };
  isActive: boolean;
}

// Gate types
export enum GateType {
  VEHICLE = 'vehicle',
  PEDESTRIAN = 'pedestrian',
  MIXED = 'mixed',
}

export enum GateState {
  CLOSED = 'CLOSED',
  OPENING = 'OPENING',
  OPEN = 'OPEN',
  CLOSING = 'CLOSING',
  OBSTACLE_HOLD = 'OBSTACLE_HOLD',
  FAULT = 'FAULT',
  MANUAL_OVERRIDE = 'MANUAL_OVERRIDE',
}

export interface Gate {
  id: string;
  name: string;
  type: GateType;
  location?: string;
  description?: string;
  state: GateState;
  isOnline: boolean;
  lastHeartbeatAt?: string;
  tenantId: string;
  hardwareId?: string;
  deviceName?: string;
  createdAt: string;
  updatedAt: string;
}

// Sensor types
export enum SensorType {
  ESP32_CONTROLLER = 'esp32_controller',
  RFID_READER = 'rfid_reader',
  IR_OBSTACLE = 'ir_obstacle',
  ULTRASONIC = 'ultrasonic',
  LIMIT_SWITCH_OPEN = 'limit_switch_open',
  LIMIT_SWITCH_CLOSE = 'limit_switch_close',
  SERVO_ACTUATOR = 'servo_actuator',
  OLED_DISPLAY = 'oled_display',
  LED_BUZZER = 'led_buzzer',
}

export enum SensorHealthStatus {
  OK = 'ok',
  ABNORMAL = 'abnormal',
  MISSING = 'missing',
  OFFLINE = 'offline',
  UNKNOWN = 'unknown',
}

export interface SensorStatus {
  sensorType: SensorType;
  status: SensorHealthStatus;
  lastValue?: string;
  lastReadingAt?: string;
  notes?: string;
}

export interface GateHealth {
  gateId: string;
  gateName: string;
  isOnline: boolean;
  lastHeartbeatAt?: string;
  sensors: SensorStatus[];
  firmwareVersion?: string;
  wifiStrength?: number;
  uptimeSeconds?: number;
}

// Access Event types
export enum AccessMethod {
  CAR_RFID = 'car_rfid',
  HUMAN_RFID = 'human_rfid',
  QR = 'qr',
  WEB_APP = 'web_app',
  MANUAL = 'manual',
}

export enum AccessResult {
  ALLOWED = 'allowed',
  DENIED = 'denied',
}

export interface AccessEvent {
  id: string;
  gateId: string;
  gateName?: string;
  timestamp: string;
  method: AccessMethod;
  subjectType: string;
  subjectId?: string;
  subjectIdentifier?: string;
  subjectName?: string;
  result: AccessResult;
  denialReason?: string;
  operatorName?: string;
}

// Simulator types
export enum SimulatorEvent {
  CAR_RFID_DETECTED = 'car_rfid_detected',
  HUMAN_RFID_DETECTED = 'human_rfid_detected',
  QR_VERIFIED = 'qr_verified',
  OBSTACLE_DETECTED = 'obstacle_detected',
  OBSTACLE_CLEARED = 'obstacle_cleared',
  LIMIT_OPEN_REACHED = 'limit_open_reached',
  LIMIT_CLOSE_REACHED = 'limit_close_reached',
  MANUAL_OPEN = 'manual_open',
  MANUAL_CLOSE = 'manual_close',
}

export interface SimulatorFeedback {
  gateId: string;
  action: string;
  success: boolean;
  message: string;
  gateState: GateState;
  eventId?: string;
}

// Auth types
export interface LoginCredentials {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthState {
  user: User | null;
  tokens: AuthTokens | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}
