/**
 * Cloud Plus TypeB TCP Server
 * Handles persistent TCP connections with Cloud Plus controllers
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  TcpCommand,
  validatePacket,
  parseHeartbeat,
  parseRequestEvent,
  buildHeartbeatAck,
  bufferToHex,
  HeartbeatInfo,
  RequestEvent,
} from './tcp-protocol';
import { ConnectedController, ControllerEvent } from './dto';

interface ControllerConnection {
  socket: net.Socket;
  serial: string;
  id: string;
  gateId?: string;
  tenantId?: string;
  ipAddress: string;
  port: number;
  connectedAt: Date;
  lastHeartbeat: Date;
  doorStatus: number;
  oemCode: number;
  version: number;
  receiveBuffer: Buffer;
}

@Injectable()
export class CloudPlusTcpServer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CloudPlusTcpServer.name);
  private server: net.Server | null = null;
  private connections: Map<string, ControllerConnection> = new Map();
  private serialToSocketId: Map<string, string> = new Map();
  private readonly port: number;

  constructor(
    private configService: ConfigService,
    private eventEmitter: EventEmitter2,
  ) {
    this.port = this.configService.get<number>('TCP_PORT', 8002);
  }

  async onModuleInit() {
    await this.startServer();
  }

  async onModuleDestroy() {
    await this.stopServer();
  }

  /**
   * Start TCP server
   */
  async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        // A port clash on this OPTIONAL hardware server must not take down the
        // whole HTTP API. Log and continue; the REST app keeps serving. Other
        // (unexpected) socket errors are still surfaced.
        if (err.code === 'EADDRINUSE') {
          this.logger.warn(
            `TCP port ${this.port} already in use — Cloud Plus TCP server not started. The HTTP API is unaffected.`,
          );
          resolve();
          return;
        }
        this.logger.error(`TCP Server error: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.port, () => {
        this.logger.log(`TCP Server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop TCP server
   */
  async stopServer(): Promise<void> {
    // Close all connections
    for (const [socketId, conn] of this.connections) {
      conn.socket.destroy();
    }
    this.connections.clear();
    this.serialToSocketId.clear();

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.logger.log('TCP Server stopped');
          resolve();
        });
      });
    }
  }

  /**
   * Handle new connection
   */
  private handleConnection(socket: net.Socket): void {
    const socketId = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.log(`New connection from ${socketId}`);

    const connection: ControllerConnection = {
      socket,
      serial: '',
      id: '',
      ipAddress: socket.remoteAddress || 'unknown',
      port: socket.remotePort || 0,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      doorStatus: 0,
      oemCode: 0,
      version: 0,
      receiveBuffer: Buffer.alloc(0),
    };

    this.connections.set(socketId, connection);

    socket.on('data', (data) => {
      this.handleData(socketId, data);
    });

    socket.on('close', () => {
      this.logger.log(`Connection closed: ${socketId}`);
      this.handleDisconnect(socketId);
    });

    socket.on('error', (err) => {
      this.logger.error(`Socket error (${socketId}): ${err.message}`);
    });

    socket.on('timeout', () => {
      this.logger.warn(`Socket timeout: ${socketId}`);
      socket.destroy();
    });

    // Set socket timeout (5 minutes)
    socket.setTimeout(300000);
  }

  /**
   * Handle incoming data
   */
  private handleData(socketId: string, data: Buffer): void {
    const conn = this.connections.get(socketId);
    if (!conn) return;

    // Append to receive buffer
    conn.receiveBuffer = Buffer.concat([conn.receiveBuffer, data]);

    // Process complete packets
    this.processPackets(socketId, conn);
  }

  /**
   * Process complete packets from buffer
   */
  private processPackets(socketId: string, conn: ControllerConnection): void {
    while (conn.receiveBuffer.length >= 9) {
      // Find start byte
      const startIndex = conn.receiveBuffer.indexOf(0x02);
      if (startIndex === -1) {
        conn.receiveBuffer = Buffer.alloc(0);
        return;
      }

      // Remove bytes before start
      if (startIndex > 0) {
        conn.receiveBuffer = conn.receiveBuffer.slice(startIndex);
      }

      // Check if we have enough data to read length
      if (conn.receiveBuffer.length < 9) return;

      // Get data length
      const dataLen = conn.receiveBuffer[5] + (conn.receiveBuffer[6] << 8);
      const packetLen = 7 + dataLen + 2; // header + data + checksum + end

      // Wait for complete packet
      if (conn.receiveBuffer.length < packetLen) return;

      // Extract packet
      const packet = conn.receiveBuffer.slice(0, packetLen);
      conn.receiveBuffer = conn.receiveBuffer.slice(packetLen);

      // Validate and process
      if (validatePacket(packet)) {
        this.processPacket(socketId, conn, packet);
      } else {
        this.logger.warn(`Invalid packet from ${socketId}: ${bufferToHex(packet)}`);
      }
    }
  }

  /**
   * Process a single packet
   */
  private processPacket(socketId: string, conn: ControllerConnection, packet: Buffer): void {
    const command = packet[2];

    switch (command) {
      case TcpCommand.HEARTBEAT:
        this.handleHeartbeat(socketId, conn, packet);
        break;

      case TcpCommand.REQUEST_EVENT:
        this.handleRequestEvent(socketId, conn, packet);
        break;

      default:
        // Command acknowledgment
        this.logger.debug(
          `Command ack (${command.toString(16)}) from ${conn.serial}: ${bufferToHex(packet)}`,
        );
    }
  }

  /**
   * Handle heartbeat from controller
   */
  private handleHeartbeat(socketId: string, conn: ControllerConnection, packet: Buffer): void {
    const info = parseHeartbeat(packet);
    if (!info) {
      this.logger.warn(`Failed to parse heartbeat from ${socketId}`);
      return;
    }

    const isNewController = !conn.serial;

    // Update connection info
    conn.serial = info.serial;
    conn.id = info.id;
    conn.doorStatus = info.doorStatus;
    conn.oemCode = info.oemCode;
    conn.version = info.version;
    conn.lastHeartbeat = new Date();

    // Map serial to socket
    this.serialToSocketId.set(info.serial, socketId);

    // Send acknowledgment
    const ack = buildHeartbeatAck(info.oemCode);
    conn.socket.write(ack);

    if (isNewController) {
      this.logger.log(`Controller connected: ${info.serial} (OEM: ${info.oemCode.toString(16)})`);

      // Emit event for new controller
      this.eventEmitter.emit('tcp.controller.connected', {
        serial: info.serial,
        id: info.id,
        ipAddress: conn.ipAddress,
        oemCode: info.oemCode,
      });
    }

    // Emit heartbeat event
    this.eventEmitter.emit('tcp.controller.heartbeat', {
      serial: info.serial,
      doorStatus: info.doorStatus,
    });
  }

  /**
   * Handle card swipe / button press event from controller
   */
  private handleRequestEvent(socketId: string, conn: ControllerConnection, packet: Buffer): void {
    const event = parseRequestEvent(packet);
    if (!event) {
      this.logger.warn(`Failed to parse request event from ${socketId}`);
      return;
    }

    this.logger.log(
      `Request event from ${conn.serial}: Reader=${event.reader}, Door=${event.door}, Type=${event.dataType}, Card=${event.card}`,
    );

    // Emit event for processing
    const controllerEvent: ControllerEvent = {
      serial: event.serial || conn.serial,
      id: event.id || conn.id,
      reader: event.reader,
      door: event.door,
      dataType: event.dataType,
      card: event.card,
      cardInt: event.cardInt,
      timestamp: new Date(),
      datetime: event.datetime,
    };

    this.eventEmitter.emit('tcp.controller.event', {
      socketId,
      event: controllerEvent,
    });
  }

  /**
   * Send command to controller by serial number
   */
  sendCommand(serial: string, command: Buffer): boolean {
    const socketId = this.serialToSocketId.get(serial);
    if (!socketId) {
      this.logger.warn(`Controller not connected: ${serial}`);
      return false;
    }

    const conn = this.connections.get(socketId);
    if (!conn || !conn.socket.writable) {
      this.logger.warn(`Socket not writable for: ${serial}`);
      return false;
    }

    this.logger.debug(`Sending command to ${serial}: ${bufferToHex(command)}`);
    conn.socket.write(command);
    return true;
  }

  /**
   * Send event response to controller
   */
  sendEventResponse(socketId: string, response: Buffer): boolean {
    const conn = this.connections.get(socketId);
    if (!conn || !conn.socket.writable) {
      return false;
    }

    conn.socket.write(response);
    return true;
  }

  /**
   * Get connection by serial number
   */
  getConnectionBySerial(serial: string): ControllerConnection | undefined {
    const socketId = this.serialToSocketId.get(serial);
    if (!socketId) return undefined;
    return this.connections.get(socketId);
  }

  /**
   * Check if controller is connected
   */
  isConnected(serial: string): boolean {
    return this.serialToSocketId.has(serial);
  }

  /**
   * Get all connected controllers
   */
  getConnectedControllers(): ConnectedController[] {
    const controllers: ConnectedController[] = [];

    for (const [socketId, conn] of this.connections) {
      if (conn.serial) {
        controllers.push({
          serial: conn.serial,
          id: conn.id,
          gateId: conn.gateId,
          tenantId: conn.tenantId,
          ipAddress: conn.ipAddress,
          port: conn.port,
          connectedAt: conn.connectedAt,
          lastHeartbeat: conn.lastHeartbeat,
          doorStatus: conn.doorStatus,
          oemCode: conn.oemCode,
          version: conn.version,
          online: true,
        });
      }
    }

    return controllers;
  }

  /**
   * Get server status
   */
  getStatus() {
    return {
      running: this.server?.listening || false,
      port: this.port,
      connectedControllers: this.serialToSocketId.size,
      controllers: this.getConnectedControllers(),
    };
  }

  /**
   * Update gate association for a controller
   */
  setControllerGate(serial: string, gateId: string, tenantId: string): boolean {
    const socketId = this.serialToSocketId.get(serial);
    if (!socketId) return false;

    const conn = this.connections.get(socketId);
    if (!conn) return false;

    conn.gateId = gateId;
    conn.tenantId = tenantId;
    return true;
  }

  /**
   * Handle disconnect
   */
  private handleDisconnect(socketId: string): void {
    const conn = this.connections.get(socketId);
    if (conn && conn.serial) {
      this.logger.log(`Controller disconnected: ${conn.serial}`);
      this.serialToSocketId.delete(conn.serial);

      // Emit disconnect event
      this.eventEmitter.emit('tcp.controller.disconnected', {
        serial: conn.serial,
      });
    }
    this.connections.delete(socketId);
  }
}
