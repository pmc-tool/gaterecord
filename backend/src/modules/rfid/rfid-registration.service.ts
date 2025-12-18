import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { RfidCard, RfidCardStatus } from '@database/entities/rfid-card.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { GatewayService } from '../gateway/gateway.service';

interface RegistrationSession {
  sessionId: string;
  targetType: 'vehicle' | 'resident';
  targetId: string;
  tenantId: string;
  createdAt: Date;
  expiresAt: Date;
}

@Injectable()
export class RfidRegistrationService {
  private readonly logger = new Logger(RfidRegistrationService.name);
  private activeSessions: Map<string, RegistrationSession> = new Map();
  private sessionsByTenant: Map<string, Set<string>> = new Map();

  constructor(
    @InjectRepository(RfidCard)
    private rfidCardRepository: Repository<RfidCard>,
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    @Inject(forwardRef(() => GatewayService))
    private gatewayService: GatewayService,
  ) {
    // Clean up expired sessions every minute
    setInterval(() => this.cleanupExpiredSessions(), 60000);
  }

  /**
   * Start a new RFID registration session
   */
  startSession(
    targetType: 'vehicle' | 'resident',
    targetId: string,
    tenantId: string,
  ): { sessionId: string; expiresAt: Date } {
    const sessionId = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes

    const session: RegistrationSession = {
      sessionId,
      targetType,
      targetId,
      tenantId,
      createdAt: now,
      expiresAt,
    };

    this.activeSessions.set(sessionId, session);

    // Track sessions by tenant for lookup during RFID scans
    if (!this.sessionsByTenant.has(tenantId)) {
      this.sessionsByTenant.set(tenantId, new Set());
    }
    this.sessionsByTenant.get(tenantId)!.add(sessionId);

    this.logger.log(`=== REGISTRATION SESSION STARTED ===`);
    this.logger.log(`Session ID: ${sessionId}`);
    this.logger.log(`Target: ${targetType}:${targetId}`);
    this.logger.log(`Tenant ID: ${tenantId}`);
    this.logger.log(`Expires at: ${expiresAt.toISOString()}`);
    this.logger.log(`Total active sessions: ${this.activeSessions.size}`);

    return { sessionId, expiresAt };
  }

  /**
   * Cancel an active registration session
   */
  cancelSession(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return false;
    }

    this.activeSessions.delete(sessionId);
    this.sessionsByTenant.get(session.tenantId)?.delete(sessionId);

    this.logger.log(`Cancelled registration session ${sessionId}`);
    return true;
  }

  /**
   * Get active registration session for a tenant (if any)
   */
  getActiveSessionForTenant(tenantId: string): RegistrationSession | null {
    const sessionIds = this.sessionsByTenant.get(tenantId);
    if (!sessionIds || sessionIds.size === 0) {
      return null;
    }

    // Return the first active session
    for (const sessionId of sessionIds) {
      const session = this.activeSessions.get(sessionId);
      if (session && session.expiresAt > new Date()) {
        return session;
      }
    }

    return null;
  }

  /**
   * Process an RFID scan during registration mode
   * Returns true if the scan was handled by a registration session
   */
  async processRegistrationScan(
    tenantId: string,
    rfidUid: string,
    scanType: 'vehicle' | 'human',
  ): Promise<boolean> {
    this.logger.log(`========================================`);
    this.logger.log(`RFID SCAN RECEIVED - Checking for registration`);
    this.logger.log(`Gate Tenant ID: ${tenantId}`);
    this.logger.log(`RFID UID: ${rfidUid}`);
    this.logger.log(`Scan Type: ${scanType}`);
    this.logger.log(`Active sessions count: ${this.activeSessions.size}`);

    // Log all active sessions for debugging
    this.activeSessions.forEach((session, sessionId) => {
      this.logger.log(`  Session ${sessionId}: tenant=${session.tenantId}, target=${session.targetType}:${session.targetId}`);
    });

    const session = this.getActiveSessionForTenant(tenantId);
    if (!session) {
      this.logger.log(`NO REGISTRATION SESSION for tenant ${tenantId}`);
      this.logger.log(`Available tenant sessions: ${JSON.stringify(Array.from(this.sessionsByTenant.keys()))}`);
      this.logger.log(`========================================`);
      return false;
    }

    this.logger.log(`Processing registration scan for session ${session.sessionId}: ${rfidUid}`);

    try {
      // Save the RFID UID to the appropriate target
      if (session.targetType === 'vehicle') {
        await this.assignRfidToVehicle(session.targetId, rfidUid);
      } else {
        await this.createRfidCardForResident(session.targetId, session.tenantId, rfidUid);
      }

      // Notify frontend via WebSocket
      const eventData = {
        sessionId: session.sessionId,
        rfidUid,
        type: scanType,
        tenantId,
        success: true,
      };
      this.logger.log(`=== BROADCASTING TO FRONTEND ===`);
      this.logger.log(`Tenant ID: ${tenantId}`);
      this.logger.log(`Event: rfid:registration-scan`);
      this.logger.log(`Data: ${JSON.stringify(eventData)}`);
      this.gatewayService.broadcastToTenant(tenantId, 'rfid:registration-scan', eventData);

      // Clean up the session
      this.cancelSession(session.sessionId);

      return true;
    } catch (error) {
      this.logger.error(`Failed to process registration scan: ${error}`);

      // Notify frontend of error
      this.gatewayService.broadcastToTenant(tenantId, 'rfid:registration-error', {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : 'Registration failed',
      });

      return false;
    }
  }

  /**
   * Assign RFID UID to a vehicle
   */
  private async assignRfidToVehicle(vehicleId: string, rfidUid: string): Promise<void> {
    const vehicle = await this.vehicleRepository.findOne({ where: { id: vehicleId } });
    if (!vehicle) {
      throw new Error('Vehicle not found');
    }

    // Check if RFID is already in use
    const existingVehicle = await this.vehicleRepository.findOne({
      where: { tenantId: vehicle.tenantId, rfidUid },
    });
    if (existingVehicle && existingVehicle.id !== vehicleId) {
      throw new Error('RFID UID is already assigned to another vehicle');
    }

    vehicle.rfidUid = rfidUid;
    await this.vehicleRepository.save(vehicle);

    this.logger.log(`Assigned RFID ${rfidUid} to vehicle ${vehicleId}`);
  }

  /**
   * Create a new RFID card for a resident
   */
  private async createRfidCardForResident(
    userId: string,
    tenantId: string,
    rfidUid: string,
  ): Promise<RfidCard> {
    // Check if RFID is already in use
    const existingCard = await this.rfidCardRepository.findOne({
      where: { tenantId, uid: rfidUid },
    });
    if (existingCard) {
      throw new Error('RFID card is already registered');
    }

    const card = this.rfidCardRepository.create({
      uid: rfidUid,
      userId,
      tenantId,
      status: RfidCardStatus.ACTIVE,
      label: 'Access Card',
    });

    const saved = await this.rfidCardRepository.save(card);
    this.logger.log(`Created RFID card ${rfidUid} for user ${userId}`);

    return saved;
  }

  /**
   * Clean up expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = new Date();
    let cleaned = 0;

    for (const [sessionId, session] of this.activeSessions.entries()) {
      if (session.expiresAt < now) {
        this.activeSessions.delete(sessionId);
        this.sessionsByTenant.get(session.tenantId)?.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.log(`Cleaned up ${cleaned} expired registration sessions`);
    }
  }

  /**
   * Check if there's an active registration session for a tenant
   */
  hasActiveSession(tenantId: string): boolean {
    return this.getActiveSessionForTenant(tenantId) !== null;
  }

  /**
   * Debug method to get all active sessions
   */
  getActiveSessionsDebug(): Record<string, unknown>[] {
    const sessions: Record<string, unknown>[] = [];
    this.activeSessions.forEach((session, sessionId) => {
      sessions.push({
        sessionId,
        tenantId: session.tenantId,
        targetType: session.targetType,
        targetId: session.targetId,
        expiresAt: session.expiresAt.toISOString(),
      });
    });
    return sessions;
  }
}
