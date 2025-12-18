import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mqtt from 'mqtt';

export interface MqttMessage {
  topic: string;
  payload: Record<string, unknown>;
}

type MessageHandler = (topic: string, payload: Record<string, unknown>) => void;

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private client: mqtt.MqttClient | null = null;
  private readonly logger = new Logger(MqttService.name);
  private messageHandlers: Map<string, MessageHandler[]> = new Map();
  private isConnected = false;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    const brokerUrl = this.configService.get<string>('MQTT_BROKER_URL') || 'mqtt://localhost:1883';
    const username = this.configService.get<string>('MQTT_USERNAME');
    const password = this.configService.get<string>('MQTT_PASSWORD');

    const options: mqtt.IClientOptions = {
      clientId: `gate-management-server-${Date.now()}`,
      clean: true,
      connectTimeout: 5000,
      reconnectPeriod: 5000,
    };

    if (username && password) {
      options.username = username;
      options.password = password;
    }

    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(brokerUrl, options);

      this.client.on('connect', () => {
        this.logger.log(`Connected to MQTT broker: ${brokerUrl}`);
        this.isConnected = true;

        // Subscribe to all gate topics
        this.client?.subscribe('gate/+/status', { qos: 1 });
        this.client?.subscribe('gate/+/event', { qos: 1 });
        this.client?.subscribe('gate/+/sensors', { qos: 0 });

        resolve();
      });

      this.client.on('error', (error) => {
        this.logger.error(`MQTT connection error: ${error.message}`);
        if (!this.isConnected) {
          // Don't reject on reconnect attempts
          this.logger.warn('MQTT broker not available, will retry...');
          resolve(); // Resolve anyway to not block app startup
        }
      });

      this.client.on('close', () => {
        this.logger.warn('MQTT connection closed');
        this.isConnected = false;
      });

      this.client.on('reconnect', () => {
        this.logger.log('Attempting to reconnect to MQTT broker...');
      });

      this.client.on('message', (topic, message) => {
        this.handleMessage(topic, message);
      });
    });
  }

  private async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.client) {
        this.client.end(false, {}, () => {
          this.logger.log('Disconnected from MQTT broker');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleMessage(topic: string, message: Buffer): void {
    try {
      const payload = JSON.parse(message.toString());
      this.logger.debug(`Received MQTT message on ${topic}: ${JSON.stringify(payload)}`);

      // Find matching handlers
      for (const [pattern, handlers] of this.messageHandlers) {
        if (this.topicMatches(pattern, topic)) {
          handlers.forEach((handler) => handler(topic, payload));
        }
      }
    } catch (error) {
      this.logger.error(`Failed to parse MQTT message on ${topic}: ${error}`);
    }
  }

  private topicMatches(pattern: string, topic: string): boolean {
    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');

    if (patternParts.length !== topicParts.length) {
      // Check for # wildcard at end
      if (patternParts[patternParts.length - 1] === '#') {
        return topicParts
          .slice(0, patternParts.length - 1)
          .every((part, i) => patternParts[i] === '+' || patternParts[i] === part);
      }
      return false;
    }

    return patternParts.every(
      (part, i) => part === '+' || part === topicParts[i],
    );
  }

  subscribe(topicPattern: string, handler: MessageHandler): void {
    if (!this.messageHandlers.has(topicPattern)) {
      this.messageHandlers.set(topicPattern, []);
    }
    this.messageHandlers.get(topicPattern)?.push(handler);
  }

  unsubscribe(topicPattern: string, handler: MessageHandler): void {
    const handlers = this.messageHandlers.get(topicPattern);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  async publish(topic: string, payload: Record<string, unknown>, qos: 0 | 1 | 2 = 1): Promise<void> {
    this.logger.log(`>>> MQTT publish called - topic: ${topic}, connected: ${this.isConnected}`);
    if (!this.client || !this.isConnected) {
      this.logger.warn(`Cannot publish to ${topic}: MQTT not connected`);
      return;
    }

    return new Promise((resolve, reject) => {
      this.client?.publish(
        topic,
        JSON.stringify(payload),
        { qos },
        (error) => {
          if (error) {
            this.logger.error(`Failed to publish to ${topic}: ${error.message}`);
            reject(error);
          } else {
            this.logger.debug(`Published to ${topic}: ${JSON.stringify(payload)}`);
            resolve();
          }
        },
      );
    });
  }

  // Convenience methods for gate commands
  async sendGateCommand(
    deviceId: string,
    command: 'OPEN' | 'CLOSE' | 'STOP' | 'STATUS',
    params?: Record<string, unknown>,
  ): Promise<void> {
    await this.publish(`gate/${deviceId}/command`, {
      command,
      timestamp: new Date().toISOString(),
      ...params,
    });
  }

  async sendDisplayMessage(deviceId: string, line1: string, line2?: string): Promise<void> {
    await this.publish(`gate/${deviceId}/display`, {
      line1,
      line2: line2 || '',
      timestamp: new Date().toISOString(),
    });
  }

  async sendFeedback(
    deviceId: string,
    type: 'SUCCESS' | 'ERROR' | 'WARNING',
    beep: boolean = true,
  ): Promise<void> {
    await this.publish(`gate/${deviceId}/feedback`, {
      type,
      beep,
      timestamp: new Date().toISOString(),
    });
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }
}
