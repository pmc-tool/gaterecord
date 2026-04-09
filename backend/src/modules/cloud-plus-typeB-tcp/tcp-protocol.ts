/**
 * Cloud Plus TypeB TCP Protocol Helper
 * Packet structure and command building utilities
 *
 * Packet Structure:
 * [0] = 0x02 (start byte)
 * [1] = 0x00 (reserved)
 * [2] = command
 * [3] = address
 * [4] = door address
 * [5-6] = data length (low, high)
 * [7...] = data
 * [n-1] = XOR checksum
 * [n] = 0x03 (end byte)
 */

// Packet structure constants
export const PACKET = {
  START_BYTE: 0x02,
  END_BYTE: 0x03,
  LOC_BEGIN: 0,
  LOC_TEMP: 1,
  LOC_COMMAND: 2,
  LOC_ADDRESS: 3,
  LOC_DOOR_ADDR: 4,
  LOC_LEN: 5,
  LOC_DATA: 7,
};

// Command codes per official Cloud Plus TypeB SDK
export enum TcpCommand {
  // Control commands
  OPEN_DOOR = 0x2c,
  OPEN_DOOR_LONG = 0x2d,
  CLOSE_DOOR = 0x2e,
  LOCK_DOOR = 0x2f,

  // System commands
  RESET_SYSTEM = 0x04,
  RESTART = 0x05,
  SET_TIME = 0x07,

  // Alarm commands
  SET_ALARM = 0x18,
  SET_FIRE = 0x19,

  // Reader control
  DISABLE_READER = 0x5a,

  // Parameter commands
  SET_DOOR_PARAMS = 0x61,
  SET_CONTROL_PARAMS = 0x63,

  // Open with info
  OPEN_WITH_INFO = 0x73,

  // LCD/Display commands
  SPEAKER = 0x80,
  LCD_LINES = 0x82,
  LCD_PAGE = 0x83,

  // Events
  HEARTBEAT = 0x56,
  REQUEST_EVENT = 0x53,
  REQUEST_EVENT_ACK = 0x54,

  // 485 forwarding
  SEND_TO_485 = 0xb1,
}

/**
 * Data types for Request Events (card swipe, etc.)
 * Per official SDK: NET_DATA_TYPE_*
 */
export enum DataType {
  CARD = 0, // Card number (integer)
  QRCODE_SERIAL = 1, // Serial port QR code/string
  PIN = 2, // Password
  BUTTON = 3, // Button press request
  PC = 4, // PC command
  ALARM = 5, // Alarm
  CHINA_ID = 6, // Chinese ID card
  BASE64 = 9, // Base64 encoded (QR code)
  FINGER = 10, // Fingerprint
  VEIN = 11, // Finger vein
  RFID = 12, // RFID card
  FACE = 13, // Face recognition
  HONGKONG_ID = 14, // Hong Kong ID card
  FOREIGNER = 15, // Foreigner card
  QR = 16, // QR code (HTTP protocol)
  FACE2 = 23, // Face recognition v2
  CHINA_ID2 = 26, // Chinese ID card v2
  POST_DATA = 28, // POST data
  CLIENT = 50, // Client data
}

/**
 * Calculate XOR checksum for packet
 */
export function calculateChecksum(buffer: Buffer, length: number): number {
  let checksum = 0;
  for (let i = 0; i < length; i++) {
    checksum ^= buffer[i];
  }
  return checksum;
}

/**
 * Build packet header
 */
export function buildHeader(command: number, door: number = 0, address: number = 0): Buffer {
  const header = Buffer.alloc(7);
  header[PACKET.LOC_BEGIN] = PACKET.START_BYTE;
  header[PACKET.LOC_TEMP] = 0x00;
  header[PACKET.LOC_COMMAND] = command;
  header[PACKET.LOC_ADDRESS] = address;
  header[PACKET.LOC_DOOR_ADDR] = door;
  header[PACKET.LOC_LEN] = 0;
  header[PACKET.LOC_LEN + 1] = 0;
  return header;
}

/**
 * Finalize packet with length and checksum
 */
export function finalizePacket(header: Buffer, data?: Buffer): Buffer {
  const dataLength = data ? data.length : 0;

  // Set data length in header
  header[PACKET.LOC_LEN] = dataLength & 0xff;
  header[PACKET.LOC_LEN + 1] = (dataLength >> 8) & 0xff;

  // Combine header and data
  const packet = data ? Buffer.concat([header, data]) : header;

  // Calculate checksum
  const checksum = calculateChecksum(packet, packet.length);

  // Add checksum and end byte
  const finalPacket = Buffer.alloc(packet.length + 2);
  packet.copy(finalPacket);
  finalPacket[packet.length] = checksum;
  finalPacket[packet.length + 1] = PACKET.END_BYTE;

  return finalPacket;
}

/**
 * Build simple door command (open/close/lock)
 */
export function buildDoorCommand(command: TcpCommand, door: number): Buffer {
  const header = buildHeader(command, door + 1);
  return finalizePacket(header);
}

/**
 * Build Open Door command
 */
export function buildOpenDoorCommand(door: number = 0): Buffer {
  return buildDoorCommand(TcpCommand.OPEN_DOOR, door);
}

/**
 * Build Open Door Long (hold open) command
 */
export function buildOpenDoorLongCommand(door: number = 0): Buffer {
  return buildDoorCommand(TcpCommand.OPEN_DOOR_LONG, door);
}

/**
 * Build Close Door command
 */
export function buildCloseDoorCommand(door: number = 0): Buffer {
  return buildDoorCommand(TcpCommand.CLOSE_DOOR, door);
}

/**
 * Build Lock/Unlock Door command
 * Per SDK: sends 2 bytes - lock state twice
 */
export function buildLockDoorCommand(door: number, lock: boolean): Buffer {
  const header = buildHeader(TcpCommand.LOCK_DOOR, door + 1);
  const lockByte = lock ? 1 : 0;
  const data = Buffer.from([lockByte, lockByte]);
  return finalizePacket(header, data);
}

/**
 * Build Set Alarm command
 * Per SDK: enable=false means alarm ON, enable=true means alarm OFF (inverted)
 */
export function buildSetAlarmCommand(enable: boolean, longtime: number = 0): Buffer {
  const header = buildHeader(TcpCommand.SET_ALARM);
  const data = Buffer.from([enable ? 0 : 1, longtime & 0xff]);
  return finalizePacket(header, data);
}

/**
 * Build Set Fire (emergency) command
 * Per SDK: enable=false means fire mode ON, second byte is longtime flag
 * Fire mode typically opens all doors
 */
export function buildSetFireCommand(enable: boolean): Buffer {
  const header = buildHeader(TcpCommand.SET_FIRE);
  const data = Buffer.from([enable ? 0 : 1, 1]); // second byte is longtime=true
  return finalizePacket(header, data);
}

/**
 * Build Set System Time command
 */
export function buildSetTimeCommand(date: Date = new Date()): Buffer {
  const header = buildHeader(TcpCommand.SET_TIME);
  const data = Buffer.from([
    date.getSeconds(),
    date.getMinutes(),
    date.getHours(),
    date.getDay() + 1,
    date.getDate(),
    date.getMonth() + 1,
    (date.getFullYear() - 2000) & 0xff,
  ]);
  return finalizePacket(header, data);
}

/**
 * Build Restart command
 */
export function buildRestartCommand(): Buffer {
  const header = buildHeader(TcpCommand.RESTART);
  return finalizePacket(header);
}

/**
 * Build Reset System command
 */
export function buildResetCommand(): Buffer {
  const header = buildHeader(TcpCommand.RESET_SYSTEM);
  return finalizePacket(header);
}

/**
 * Build Heartbeat Acknowledgment
 * Note: OEM code is sent in Big Endian (high byte first) per official SDK
 */
export function buildHeartbeatAck(oemCode: number = 0x1001): Buffer {
  const header = buildHeader(TcpCommand.HEARTBEAT);
  // Big Endian: high byte first, matching official SDK AckHeart()
  const data = Buffer.from([(oemCode >> 8) & 0xff, oemCode & 0xff]);
  return finalizePacket(header, data);
}

/**
 * String to GB2312 bytes with fixed length
 */
export function stringToGB2312(str: string, maxLen: number): Buffer {
  const buffer = Buffer.alloc(maxLen, 0);
  if (str) {
    // For simplicity, use UTF-8 encoding (GB2312 would need iconv-lite)
    const encoded = Buffer.from(str, 'utf8');
    const len = Math.min(encoded.length, maxLen);
    encoded.copy(buffer, 0, 0, len);
  }
  return buffer;
}

/**
 * Build Open With Info command (opens gate and displays info on LCD)
 */
export function buildOpenWithInfoCommand(
  open: boolean,
  relay: number,
  openTime: number,
  card: string,
  name: string,
  note: string,
  time: string,
  voice: string,
): Buffer {
  const header = buildHeader(TcpCommand.OPEN_WITH_INFO);

  const data = Buffer.concat([
    Buffer.from([
      open ? 1 : 0,
      relay & 0xff,
      openTime & 0xff,
      (openTime >> 8) & 0xff,
      0, // reserved
      0,
      0,
    ]),
    stringToGB2312(card, 18),
    stringToGB2312(voice, 40),
    stringToGB2312(name, 16),
    stringToGB2312(note, 32),
    stringToGB2312(time, 20),
  ]);

  return finalizePacket(header, data);
}

/**
 * Build Request Event Acknowledgment (response to card swipe)
 */
export function buildRequestEventAck(
  open: boolean,
  relay: number,
  openTime: number,
  card: string,
  name: string,
  note: string,
  time: string,
  voice: string,
): Buffer {
  const header = buildHeader(TcpCommand.REQUEST_EVENT_ACK);

  const data = Buffer.concat([
    Buffer.from([
      open ? 1 : 0,
      relay & 0xff,
      openTime & 0xff,
      (openTime >> 8) & 0xff,
      0, // LCD page
      0, // LCD delay
      0, // reserved
    ]),
    stringToGB2312(card, 18),
    stringToGB2312(voice, 40),
    stringToGB2312(name, 16),
    stringToGB2312(note, 32),
    stringToGB2312(time, 20),
  ]);

  return finalizePacket(header, data);
}

/**
 * Build LCD Lines Display command (0x82)
 * Shows info on LCD screen
 * Per SDK: screen=address, showTime=delay before returning to home page
 */
export function buildLcdLinesCommand(
  screen: number,
  passPage: number,
  showTime: number,
  card: string,
  name: string,
  note: string,
  time: string,
): Buffer {
  const header = buildHeader(TcpCommand.LCD_LINES, 0, screen);

  const data = Buffer.concat([
    Buffer.from([showTime & 0xff, passPage & 0xff]),
    stringToGB2312(card, 18),
    stringToGB2312(name, 16),
    stringToGB2312(note, 32),
    stringToGB2312(time, 20),
  ]);

  return finalizePacket(header, data);
}

/**
 * Build LCD Page Display command (0x83)
 * Shows single line on LCD
 * Per SDK: page=page number, line=line position, delay=seconds before home
 */
export function buildLcdPageCommand(
  screen: number,
  page: number,
  line: number,
  delay: number,
  value: string,
): Buffer {
  const header = buildHeader(TcpCommand.LCD_PAGE, 0, screen);

  const data = Buffer.concat([
    Buffer.from([page & 0xff, line & 0xff, delay & 0xff]),
    stringToGB2312(value, 32),
  ]);

  return finalizePacket(header, data);
}

/**
 * Build Speaker command (0x80)
 * Play voice announcement on 485 speaker
 * Per SDK: reader=address, text=voice message to play
 */
export function buildSpeakerCommand(reader: number, text: string): Buffer {
  const header = buildHeader(TcpCommand.SPEAKER);
  const textBuffer = stringToGB2312(text, 40);
  const textLen = Math.min(text.length, 40);

  const data = Buffer.concat([Buffer.from([reader & 0xff, textLen & 0xff, 0]), textBuffer]);

  return finalizePacket(header, data);
}

/**
 * Build Send to 485 command (0xB1)
 * Forward data to RS485 bus
 * Per SDK: com=COM port (0-3 for different 485 ports)
 */
export function buildSendTo485Command(com: number, data: Buffer): Buffer {
  const header = buildHeader(TcpCommand.SEND_TO_485, 0, com & 0x03);
  const payload = data.slice(0, 512); // Max 512 bytes
  return finalizePacket(header, payload);
}

/**
 * Build Disable/Enable Reader command (0x5A)
 * Per SDK: reader=reader index, lock=true to disable
 */
export function buildDisableReaderCommand(reader: number, disable: boolean): Buffer {
  const header = buildHeader(TcpCommand.DISABLE_READER);
  const data = Buffer.from([0, reader & 0xff, 0, disable ? 1 : 0]);
  return finalizePacket(header, data);
}

/**
 * Validate received packet checksum
 */
export function validatePacket(packet: Buffer): boolean {
  if (packet.length < 9) return false;
  if (packet[0] !== PACKET.START_BYTE) return false;
  if (packet[packet.length - 1] !== PACKET.END_BYTE) return false;

  const dataLen = packet[PACKET.LOC_LEN] + (packet[PACKET.LOC_LEN + 1] << 8);
  const expectedLen = PACKET.LOC_DATA + dataLen + 2;

  if (packet.length !== expectedLen) return false;

  const checksum = calculateChecksum(packet, packet.length - 2);
  return checksum === packet[packet.length - 2];
}

/**
 * Parse heartbeat packet to extract device info
 * Per SDK RTCPHeartStatus structure offsets from data start (offset 7):
 * - N1: 0
 * - Time (6 bytes): 1-6 (year, month, day, hour, minute, second)
 * - DoorStatus: 7
 * - NN: 8
 * - DirPass: 9
 * - N2: 10
 * - ControlType: 11
 * - RelayOut: 12
 * - Output (2 bytes): 13-14
 * - N4 (3 bytes): 15-17
 * - Ver: 18
 * - OEMCode (2 bytes): 19-20
 * - Serial (6 bytes): 21-26
 * - Input (2 bytes): 27-28
 * - ID (10 bytes): 29-38
 */
export interface HeartbeatInfo {
  serial: string;
  id: string;
  doorStatus: number;
  version: number;
  oemCode: number;
  online: boolean;
  controlType: number;
  relayOut: number;
  input: number;
  output: number;
  dirPass: number;
  datetime?: Date;
}

export function parseHeartbeat(packet: Buffer): HeartbeatInfo | null {
  if (!validatePacket(packet)) return null;
  if (packet[PACKET.LOC_COMMAND] !== TcpCommand.HEARTBEAT) return null;

  // Parse heartbeat data (starts at offset 7)
  const data = packet.slice(PACKET.LOC_DATA);

  if (data.length < 39) return null; // Minimum size for basic parsing

  // Extract time (offsets 1-6 from data start)
  const year = (data[1] || 0) + 2000;
  const month = data[2] || 1;
  const day = data[3] || 1;
  const hour = data[4] || 0;
  const minute = data[5] || 0;
  const second = data[6] || 0;
  const datetime = new Date(year, month - 1, day, hour, minute, second);

  // Extract serial number (6 bytes at data offset 21)
  const serial = data.slice(21, 27).toString('ascii').replace(/\0/g, '');

  // Extract ID (10 bytes at data offset 29)
  const id = data.slice(29, 39).toString('ascii').replace(/\0/g, '');

  // OEM code at data offset 19-20 (little endian)
  const oemCode = data[19] + (data[20] << 8);

  // Other fields
  const doorStatus = data[7] || 0;
  const dirPass = data[9] || 0;
  const controlType = data[11] || 0;
  const relayOut = data[12] || 0;
  const output = data[13] + (data[14] << 8);
  const version = data[18] || 0;
  const input = data[27] + (data[28] << 8);

  return {
    serial,
    id,
    doorStatus,
    version,
    oemCode,
    online: true,
    controlType,
    relayOut,
    input,
    output,
    dirPass,
    datetime,
  };
}

/**
 * Parse request event (card swipe) packet
 * Per SDK RTCPRequestData structure offsets from data start:
 * - Serial (6 bytes): 0-5
 * - ID (10 bytes): 6-15
 * - Reader: 16
 * - N1: 17
 * - Data (4 bytes): 18-21
 * - DataType: 22
 * - year: 23, month: 24, day: 25, hour: 26, minute: 27, second: 28
 * - N2 (10 bytes): 29-38
 * - Card int (4 bytes): 39-42
 * - Value (variable): 43+
 */
export interface RequestEvent {
  serial: string;
  id: string;
  reader: number;
  door: number;
  dataType: number;
  card: string;
  cardInt: number;
  datetime: Date;
  rawData: Buffer;
  valueData: Buffer;
}

export function parseRequestEvent(packet: Buffer): RequestEvent | null {
  if (!validatePacket(packet)) return null;
  if (packet[PACKET.LOC_COMMAND] !== TcpCommand.REQUEST_EVENT) return null;

  const data = packet.slice(PACKET.LOC_DATA);

  if (data.length < 43) return null; // Minimum size

  // Serial (6 bytes) at offset 0
  const serial = data.slice(0, 6).toString('ascii').replace(/\0/g, '');

  // ID (10 bytes) at offset 6
  const id = data.slice(6, 16).toString('ascii').replace(/\0/g, '');

  // Reader at offset 16 (bottom bit), Door is (Reader >> 1) & 0x0f
  const readerByte = data[16];
  const reader = readerByte & 0x01;
  const door = (readerByte >> 1) & 0x0f;

  // DataType at offset 22
  const dataType = data[22];

  // DateTime at offsets 23-28
  const year = (data[23] || 0) + 2000;
  const month = data[24] || 1;
  const day = data[25] || 1;
  const hour = data[26] || 0;
  const minute = data[27] || 0;
  const second = data[28] || 0;
  const datetime = new Date(year, month - 1, day, hour, minute, second);

  // Card integer at offset 39-42 (little endian)
  const cardInt = data[39] + (data[40] << 8) + (data[41] << 16) + (data[42] << 24);

  // Value data starts at offset 43
  const valueData = data.slice(43);

  // Parse card based on data type
  let card = '';

  switch (dataType) {
    case DataType.CARD:
    case DataType.BUTTON:
      // Card number is integer
      card = cardInt.toString();
      break;

    case DataType.QRCODE_SERIAL:
    case DataType.PIN:
      // String value
      card = valueData.toString('utf8').replace(/\0/g, '').trim();
      break;

    case DataType.BASE64:
      // Base64 encoded
      try {
        const base64Str = valueData.toString('utf8').replace(/\0/g, '').trim();
        card = Buffer.from(base64Str, 'base64').toString('utf8').trim();
      } catch {
        card = valueData.toString('utf8').replace(/\0/g, '').trim();
      }
      break;

    case DataType.RFID:
    case DataType.CHINA_ID:
    case DataType.CHINA_ID2:
    case DataType.FACE:
    case DataType.FACE2:
    case DataType.FINGER:
    case DataType.VEIN:
    default:
      // Try to read as string, fallback to card int
      const strValue = valueData.toString('utf8').replace(/\0/g, '').trim();
      card = strValue || cardInt.toString();
      break;
  }

  return {
    serial,
    id,
    reader,
    door,
    dataType,
    card,
    cardInt,
    datetime,
    rawData: data,
    valueData,
  };
}

/**
 * Check if packet is an acknowledgment to a command
 */
export function isCommandAck(packet: Buffer, expectedCommand: TcpCommand): boolean {
  if (!validatePacket(packet)) return false;
  return packet[PACKET.LOC_COMMAND] === expectedCommand;
}

/**
 * Convert buffer to hex string for logging
 */
export function bufferToHex(buffer: Buffer): string {
  return (
    buffer
      .toString('hex')
      .toUpperCase()
      .match(/.{1,2}/g)
      ?.join(' ') || ''
  );
}
