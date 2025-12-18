import { io, Socket } from 'socket.io-client';
import { GateState, SimulatorFeedback, SensorHealthStatus } from '../types';

const WS_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3000';

interface GateStateChangeEvent {
  gateId: string;
  gateName?: string;
  previousState: GateState;
  newState: GateState;
  timestamp: string;
  trigger: string;
}

interface HealthUpdateEvent {
  gateId: string;
  gateName?: string;
  type: 'controller' | 'sensor';
  sensorType?: string;
  previousStatus: string;
  newStatus: SensorHealthStatus;
  timestamp: string;
  notes?: string;
}

interface AccessEventNotification {
  eventId: string;
  gateId: string;
  gateName: string;
  timestamp: string;
  method: string;
  subjectType: string;
  subjectName: string;
  result: string;
  denialReason?: string;
  operatorName?: string;
}

type EventCallback<T> = (data: T) => void;

class SocketService {
  private socket: Socket | null = null;
  private eventHandlers: Map<string, Set<EventCallback<unknown>>> = new Map();

  connect(token: string): void {
    if (this.socket?.connected) {
      return;
    }

    this.socket = io(WS_URL, {
      auth: { token },
      transports: ['websocket'],
    });

    this.socket.on('connect', () => {
      console.log('WebSocket connected');
    });

    this.socket.on('disconnect', () => {
      console.log('WebSocket disconnected');
    });

    this.socket.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    // Register internal event handlers
    this.socket.on('gate:state-change', (data: GateStateChangeEvent) => {
      this.emit('gate:state-change', data);
    });

    this.socket.on('access:event', (data: AccessEventNotification) => {
      this.emit('access:event', data);
    });

    this.socket.on('health:update', (data: HealthUpdateEvent) => {
      this.emit('health:update', data);
    });

    this.socket.on('simulator:feedback', (data: SimulatorFeedback) => {
      this.emit('simulator:feedback', data);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.eventHandlers.clear();
  }

  joinGate(gateId: string): void {
    this.socket?.emit('join:gate', { gateId });
  }

  leaveGate(gateId: string): void {
    this.socket?.emit('leave:gate', { gateId });
  }

  triggerSimulator(gateId: string, event: string, data?: { rfidUid?: string; qrToken?: string }): void {
    this.socket?.emit('simulator:trigger', { gateId, event, ...data });
  }

  on<T>(event: string, callback: EventCallback<T>): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(callback as EventCallback<unknown>);

    // Return unsubscribe function
    return () => {
      this.eventHandlers.get(event)?.delete(callback as EventCallback<unknown>);
    };
  }

  private emit(event: string, data: unknown): void {
    this.eventHandlers.get(event)?.forEach((callback) => callback(data));
  }

  isConnected(): boolean {
    return this.socket?.connected || false;
  }
}

export const socketService = new SocketService();
