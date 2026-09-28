/**
 * GATE-8 — overlay regression: devices scope by the OVERLAID principal
 * (contract C5). P acting in one building never lists or reads another
 * building's controllers; the Platform context sees all of them.
 *
 * No production code changed for this; pure unit tests over jest-mocked
 * repositories and a recording query builder (memberships/testing).
 */
import { ForbiddenException } from '@nestjs/common';
import { DevicesService } from './devices.service';
import {
  TOWER_A,
  TOWER_B,
  TOWER_C,
  TOWER_D,
  scenarioP,
} from '../memberships/testing/overlaid-user.factory';
import {
  RecordingQueryBuilder,
  recordingQueryBuilder,
} from '../memberships/testing/recording-query-builder';

describe('DevicesService — overlay regression (GATE-8)', () => {
  const { as } = scenarioP();
  let recorder: RecordingQueryBuilder;
  let service: DevicesService;

  beforeEach(() => {
    recorder = recordingQueryBuilder();
    service = new DevicesService(
      {} as never,
      {
        createQueryBuilder: jest.fn(() => recorder.qb),
        findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => ({
          id,
          deviceId: `SERIAL-${id}`,
          deviceName: 'Controller',
          tenantId: id,
          status: 'online',
        })),
      } as never,
      {} as never,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
    );
  });

  const tenantFilter = () => recorder.matching('device.tenantId').map((c) => c.params?.tenantId);

  it.each([
    ['A', as.A, TOWER_A],
    ['B', as.B, TOWER_B],
    ['C', as.C, TOWER_C],
  ])('P acting in %s lists that building only, ignoring ?tenantId=', async (_l, user, tenant) => {
    await service.getDevices(user, { tenantId: TOWER_D });
    expect(tenantFilter()).toEqual([tenant]);
  });

  it('the Platform context lists every building, or the one it names', async () => {
    await service.getDevices(as.platform);
    expect(tenantFilter()).toEqual([]);
    await service.getDevices(as.platform, { tenantId: TOWER_D });
    expect(tenantFilter()).toEqual([TOWER_D]);
  });

  it("reads a device of the acting building only (the mock's device id is its tenant)", async () => {
    await expect(service.getDevice(TOWER_C, as.C)).resolves.toEqual(
      expect.objectContaining({ id: TOWER_C }),
    );
    await expect(service.getDevice(TOWER_C, as.A)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getDevice(TOWER_D, as.platform)).resolves.toBeDefined();
  });
});
