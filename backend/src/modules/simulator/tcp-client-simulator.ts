/**
 * Cloud Plus TypeB TCP Client Simulator
 *
 * Simulates a real gate controller connecting via TCP protocol.
 * Use this to test the TCP server without physical hardware.
 *
 * Usage:
 *   npx ts-node src/modules/simulator/tcp-client-simulator.ts [serial] [port] [host]
 *
 * Example:
 *   npx ts-node src/modules/simulator/tcp-client-simulator.ts 1Y3196 8002 localhost
 */

import * as net from 'net';
import * as readline from 'readline';

// Configuration
const SERIAL = process.argv[2] || '1Y3196';
const TCP_PORT = parseInt(process.argv[3]) || 8002;
const HOST = process.argv[4] || 'localhost';

// Protocol constants (matching tcp-protocol.ts)
const START_BYTE = 0x02;
const END_BYTE = 0x03;

// Commands
const CMD_HEARTBEAT = 0x56;
const CMD_HEARTBEAT_ACK = 0x57;
const CMD_REQUEST_EVENT = 0x53;
const CMD_REQUEST_EVENT_ACK = 0x54;
const CMD_OPEN_DOOR = 0x2c;
const CMD_OPEN_DOOR_LONG = 0x2d;
const CMD_CLOSE_DOOR = 0x2e;
const CMD_LOCK_DOOR = 0x2f;
const CMD_SET_TIME = 0x30;
const CMD_SET_ALARM = 0x38;
const CMD_SET_FIRE = 0x39;
const CMD_RESTART = 0x3e;

// Controller state
interface ControllerState {
  doorOpen: boolean;
  locked: boolean;
  alarm: boolean;
  fire: boolean;
  oemCode: number;
  version: number;
}

const state: ControllerState = {
  doorOpen: false,
  locked: false,
  alarm: false,
  fire: false,
  oemCode: 0x01,
  version: 154,
};

/**
 * Calculate XOR checksum
 */
function calculateChecksum(buffer: Buffer, start: number, end: number): number {
  let xor = 0;
  for (let i = start; i < end; i++) {
    xor ^= buffer[i];
  }
  return xor;
}

/**
 * Build a complete packet
 */
function buildPacket(cmd: number, addr: number, door: number, data: Buffer): Buffer {
  const dataLen = data.length;
  const packet = Buffer.alloc(7 + dataLen + 2);

  packet[0] = START_BYTE;
  packet[1] = 0x00; // Temp byte
  packet[2] = cmd;
  packet[3] = addr;
  packet[4] = door;
  packet.writeUInt16LE(dataLen, 5);

  if (dataLen > 0) {
    data.copy(packet, 7);
  }

  const checksum = calculateChecksum(packet, 1, 7 + dataLen);
  packet[7 + dataLen] = checksum;
  packet[7 + dataLen + 1] = END_BYTE;

  return packet;
}

/**
 * Build heartbeat packet (0x56)
 * Controller sends this periodically to maintain connection
 */
function buildHeartbeat(): Buffer {
  // Data format: Serial(12) + DoorStatus(1) + OemCode(1) + Version(1)
  const data = Buffer.alloc(15);

  // Serial number (12 bytes, ASCII)
  const serialBytes = Buffer.from(SERIAL, 'ascii');
  serialBytes.copy(data, 0, 0, Math.min(12, serialBytes.length));

  // Door status: bit0=door1, bit1=door2, etc. 0=closed, 1=open
  data[12] = state.doorOpen ? 0x01 : 0x00;

  // OEM code
  data[13] = state.oemCode;

  // Version
  data[14] = state.version;

  return buildPacket(CMD_HEARTBEAT, 0x01, 0x01, data);
}

/**
 * Build card swipe event (0x53)
 * Simulates someone swiping a card at the reader
 */
function buildCardSwipeEvent(cardNo: string, credType: number = 0, doorNum: number = 1): Buffer {
  // Data format for RequestEvent:
  // CardNo(10) + CredType(1) + QRValid(3) + Reserved(2)
  const data = Buffer.alloc(16);

  // Card number (10 bytes)
  const cardBytes = Buffer.from(cardNo, 'ascii');
  cardBytes.copy(data, 0, 0, Math.min(10, cardBytes.length));

  // Credential type: 0=Card, 3=Button, 9=QR, 12=RFID
  data[10] = credType;

  // QR validity seconds (3 bytes, little-endian) - only for QR
  data.writeUIntLE(300, 11, 3);

  // Reserved
  data[14] = 0x00;
  data[15] = 0x00;

  return buildPacket(CMD_REQUEST_EVENT, 0x01, doorNum, data);
}

/**
 * Parse incoming command from server
 */
function parseCommand(packet: Buffer): void {
  if (packet.length < 9) {
    console.log('⚠️  Invalid packet (too short)');
    return;
  }

  if (packet[0] !== START_BYTE || packet[packet.length - 1] !== END_BYTE) {
    console.log('⚠️  Invalid packet framing');
    return;
  }

  const cmd = packet[2];
  const addr = packet[3];
  const door = packet[4];
  const dataLen = packet.readUInt16LE(5);

  console.log(
    `📥 Received: cmd=0x${cmd.toString(16).padStart(2, '0')} addr=${addr} door=${door} len=${dataLen}`,
  );

  switch (cmd) {
    case CMD_HEARTBEAT_ACK:
      console.log('   ✅ Heartbeat acknowledged');
      break;

    case CMD_OPEN_DOOR:
      state.doorOpen = true;
      state.locked = false;
      console.log('   🚪 Door OPENED (short duration)');
      // Auto-close after 3 seconds
      setTimeout(() => {
        state.doorOpen = false;
        console.log('   🚪 Door auto-closed');
      }, 3000);
      break;

    case CMD_OPEN_DOOR_LONG:
      state.doorOpen = true;
      state.locked = false;
      console.log('   🚪 Door OPENED (long duration - stays open)');
      break;

    case CMD_CLOSE_DOOR:
      state.doorOpen = false;
      console.log('   🚪 Door CLOSED');
      break;

    case CMD_LOCK_DOOR:
      state.locked = true;
      state.doorOpen = false;
      console.log('   🔒 Door LOCKED');
      break;

    case CMD_SET_ALARM:
      state.alarm = dataLen > 0 && packet[7] === 1;
      console.log(`   🚨 Alarm ${state.alarm ? 'ENABLED' : 'DISABLED'}`);
      break;

    case CMD_SET_FIRE:
      state.fire = dataLen > 0 && packet[7] === 1;
      console.log(`   🔥 Fire mode ${state.fire ? 'ENABLED' : 'DISABLED'}`);
      if (state.fire) {
        state.doorOpen = true;
        state.locked = false;
        console.log('   🚪 Emergency: All doors OPENED');
      }
      break;

    case CMD_SET_TIME:
      if (dataLen >= 7) {
        const year = packet.readUInt16LE(7);
        const month = packet[9];
        const day = packet[10];
        const hour = packet[11];
        const minute = packet[12];
        const second = packet[13];
        console.log(
          `   🕐 Time synced: ${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')} ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:${second.toString().padStart(2, '0')}`,
        );
      }
      break;

    case CMD_RESTART:
      console.log('   🔄 Restarting controller...');
      setTimeout(() => {
        console.log('   ✅ Controller restarted');
      }, 2000);
      break;

    case CMD_REQUEST_EVENT_ACK:
      // Server response to card swipe
      if (dataLen >= 1) {
        const allowed = packet[7] === 1;
        console.log(`   ${allowed ? '✅ Access GRANTED' : '❌ Access DENIED'}`);
        if (allowed) {
          state.doorOpen = true;
          setTimeout(() => {
            state.doorOpen = false;
            console.log('   🚪 Door auto-closed');
          }, 3000);
        }
      }
      break;

    default:
      console.log(`   ❓ Unknown command: 0x${cmd.toString(16)}`);
  }
}

/**
 * Main simulator
 */
function main(): void {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       Cloud Plus TypeB TCP Controller Simulator          ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║ Serial: ${SERIAL.padEnd(49)}║`);
  console.log(`║ Connecting to: ${HOST}:${TCP_PORT}`.padEnd(63) + '║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  const client = net.createConnection({ port: TCP_PORT, host: HOST }, () => {
    console.log('✅ Connected to TCP server');
    console.log('');

    // Send initial heartbeat
    const hb = buildHeartbeat();
    client.write(hb);
    console.log('📤 Sent initial heartbeat');

    // Start heartbeat interval (every 5 seconds, like real controller)
    const heartbeatInterval = setInterval(() => {
      const hb = buildHeartbeat();
      client.write(hb);
      console.log(`📤 Heartbeat (door: ${state.doorOpen ? 'OPEN' : 'CLOSED'})`);
    }, 5000);

    // Setup interactive CLI
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Interactive Commands:');
    console.log('  card <number>  - Simulate card swipe (e.g., card 1234567890)');
    console.log('  rfid <number>  - Simulate RFID tag (credType=12)');
    console.log('  qr <code>      - Simulate QR scan (credType=9)');
    console.log('  button         - Simulate exit button press (credType=3)');
    console.log('  status         - Show current door status');
    console.log('  quit           - Exit simulator');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');

    const promptUser = () => {
      rl.question('> ', (input) => {
        const parts = input.trim().split(' ');
        const cmd = parts[0].toLowerCase();
        const arg = parts.slice(1).join(' ');

        switch (cmd) {
          case 'card':
            if (arg) {
              const event = buildCardSwipeEvent(arg, 0);
              client.write(event);
              console.log(`📤 Card swipe: ${arg}`);
            } else {
              console.log('Usage: card <number>');
            }
            break;

          case 'rfid':
            if (arg) {
              const event = buildCardSwipeEvent(arg, 12);
              client.write(event);
              console.log(`📤 RFID scan: ${arg}`);
            } else {
              console.log('Usage: rfid <number>');
            }
            break;

          case 'qr':
            if (arg) {
              const event = buildCardSwipeEvent(arg, 9);
              client.write(event);
              console.log(`📤 QR scan: ${arg}`);
            } else {
              console.log('Usage: qr <code>');
            }
            break;

          case 'button':
            const buttonEvent = buildCardSwipeEvent('EXIT_BTN', 3);
            client.write(buttonEvent);
            console.log('📤 Exit button pressed');
            break;

          case 'status':
            console.log('');
            console.log('┌─────────────────────────────┐');
            console.log(`│ Door:  ${state.doorOpen ? '🟢 OPEN  ' : '🔴 CLOSED'}            │`);
            console.log(`│ Lock:  ${state.locked ? '🔒 LOCKED' : '🔓 UNLOCKED'}          │`);
            console.log(`│ Alarm: ${state.alarm ? '🚨 ON    ' : '⚪ OFF   '}            │`);
            console.log(`│ Fire:  ${state.fire ? '🔥 ON    ' : '⚪ OFF   '}            │`);
            console.log('└─────────────────────────────┘');
            console.log('');
            break;

          case 'quit':
          case 'exit':
            clearInterval(heartbeatInterval);
            client.end();
            rl.close();
            process.exit(0);
            break;

          case '':
            break;

          default:
            console.log(`Unknown command: ${cmd}`);
        }

        promptUser();
      });
    };

    promptUser();

    // Cleanup on disconnect
    client.on('close', () => {
      clearInterval(heartbeatInterval);
      rl.close();
    });
  });

  // Handle incoming data
  let buffer = Buffer.alloc(0);

  client.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);

    // Parse complete packets
    while (buffer.length >= 9) {
      const startIdx = buffer.indexOf(START_BYTE);
      if (startIdx === -1) {
        buffer = Buffer.alloc(0);
        break;
      }

      if (startIdx > 0) {
        buffer = buffer.slice(startIdx);
      }

      if (buffer.length < 7) break;

      const dataLen = buffer.readUInt16LE(5);
      const packetLen = 7 + dataLen + 2;

      if (buffer.length < packetLen) break;

      const packet = buffer.slice(0, packetLen);
      buffer = buffer.slice(packetLen);

      parseCommand(packet);
    }
  });

  client.on('error', (err) => {
    console.error('❌ Connection error:', err.message);
    console.log('');
    console.log('Make sure the backend is running with TCP_PORT configured:');
    console.log('  TCP_PORT=8002 npm run start:dev');
    process.exit(1);
  });

  client.on('close', () => {
    console.log('🔌 Connection closed');
    process.exit(0);
  });
}

main();
