import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { GateController } from './gate-controller.entity';

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

@Entity('sensor_status')
@Index(['controllerId', 'sensorType'], { unique: true })
export class SensorStatus extends BaseEntity {
  @Column({ name: 'controller_id' })
  controllerId: string;

  @ManyToOne(() => GateController, (controller) => controller.sensors)
  @JoinColumn({ name: 'controller_id' })
  controller: GateController;

  @Column({ name: 'sensor_type', type: 'enum', enum: SensorType })
  sensorType: SensorType;

  @Column({ type: 'enum', enum: SensorHealthStatus, default: SensorHealthStatus.UNKNOWN })
  status: SensorHealthStatus;

  @Column({ name: 'last_value', nullable: true })
  lastValue: string;

  @Column({ name: 'last_reading_at', nullable: true })
  lastReadingAt: Date;

  @Column({ nullable: true })
  notes: string;
}
