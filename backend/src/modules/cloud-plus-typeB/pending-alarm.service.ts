import { Injectable, Logger } from '@nestjs/common';

/**
 * Alarm command delivered to an HTTP-mode Cloud Plus controller inside the
 * response to its own GetStatus / SearchCardAcs request.
 *
 * Per the Cloud Plus TypeB HTTP protocol:
 *  - AcsRes '2' + ActIndex '2' = fire the ALARM relay for `Time` seconds
 *  - AcsRes '3' + ActIndex '2' = close (silence) the ALARM relay
 */
export interface AlarmCommand {
  AcsRes: string;
  ActIndex: string;
  Time: string;
}

interface PendingAlarm {
  /** Relay hold time (seconds) sent on every heartbeat while armed. */
  durationSec: number;
  /** Epoch ms after which the alarm auto-clears (safety net). */
  autoStopAt: number;
  /** When true, the next heartbeat sends a single CLOSE command then clears. */
  stopPending: boolean;
}

/**
 * In-memory queue of pending buzzer/alarm commands, keyed by controller serial.
 *
 * HTTP-mode controllers are clients: the server cannot push to them, it can only
 * answer their next GetStatus/SearchCardAcs poll. When a security alert fires we
 * "arm" the controller's serial here; the GetStatus handler drains it on the
 * controller's next heartbeat and returns the alarm command so the relay sounds.
 *
 * The command is re-sent on every heartbeat (re-arm) so the buzzer keeps sounding
 * until security acknowledges (disarm) or the safety timeout elapses.
 */
@Injectable()
export class PendingAlarmService {
  private readonly logger = new Logger(PendingAlarmService.name);
  private readonly alarms = new Map<string, PendingAlarm>();

  /** Buzzer can never ring longer than this even if acknowledge never happens. */
  private static readonly MAX_ALARM_SECONDS = 5 * 60;
  /** Per-heartbeat relay hold; must exceed the controller heartbeat interval. */
  private static readonly DEFAULT_DURATION_SEC = 15;

  arm(
    serial: string,
    durationSec = PendingAlarmService.DEFAULT_DURATION_SEC,
    maxSeconds = PendingAlarmService.MAX_ALARM_SECONDS,
  ): void {
    if (!serial) return;
    this.alarms.set(serial, {
      durationSec,
      autoStopAt: Date.now() + maxSeconds * 1000,
      stopPending: false,
    });
    this.logger.warn(
      `Armed HTTP alarm for controller ${serial} (Time=${durationSec}s, safety=${maxSeconds}s)`,
    );
  }

  /**
   * Request the buzzer stop. Keeps the entry so the next heartbeat can deliver a
   * single CLOSE command, then the entry is removed once that command is sent.
   */
  disarm(serial: string): void {
    if (!serial) return;
    const existing = this.alarms.get(serial);
    if (!existing) return;
    existing.stopPending = true;
    this.logger.warn(`Disarm requested for controller ${serial} - CLOSE queued for next heartbeat`);
  }

  /**
   * Drain the pending command for a serial. Called on every heartbeat.
   * Returns the alarm/close command to merge into the response, or null.
   */
  consume(serial: string): AlarmCommand | null {
    if (!serial) return null;
    const alarm = this.alarms.get(serial);
    if (!alarm) return null;

    // One-shot CLOSE after acknowledge.
    if (alarm.stopPending) {
      this.alarms.delete(serial);
      this.logger.warn(`Sending CLOSE alarm command to controller ${serial}`);
      return { AcsRes: '3', ActIndex: '2', Time: '0' };
    }

    // Safety auto-stop.
    if (Date.now() >= alarm.autoStopAt) {
      this.alarms.delete(serial);
      this.logger.warn(`HTTP alarm for ${serial} auto-expired`);
      return null;
    }

    // Re-arm the alarm relay on every heartbeat until acknowledged/expired.
    return { AcsRes: '2', ActIndex: '2', Time: String(alarm.durationSec) };
  }

  /** True if a serial currently has an active (non-stopping) alarm. */
  isArmed(serial: string): boolean {
    const alarm = this.alarms.get(serial);
    return !!alarm && !alarm.stopPending && Date.now() < alarm.autoStopAt;
  }
}
