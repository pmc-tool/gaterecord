/**
 * GATE-8 — overlay regression: RFID cards scope by the OVERLAID principal
 * (contract C5). P acting in one building cannot list, read or delete another
 * building's cards (a foreign card is "not found"); the Platform context can.
 *
 * No production code changed for this; pure unit tests over a jest-mocked
 * repository.
 */
import { NotFoundException } from '@nestjs/common';
import { RfidCardsController } from './rfid-cards.controller';
import {
  TOWER_A,
  TOWER_B,
  TOWER_C,
  TOWER_D,
  scenarioP,
} from '../memberships/testing/overlaid-user.factory';

describe('RfidCardsController — overlay regression (GATE-8)', () => {
  const { as } = scenarioP();
  let repository: { find: jest.Mock; findOne: jest.Mock; remove: jest.Mock };
  let controller: RfidCardsController;

  beforeEach(() => {
    repository = {
      find: jest.fn().mockResolvedValue([]),
      // The card id doubles as its building, to keep the fixtures short.
      findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => ({
        id,
        uid: 'AB12',
        tenantId: id,
      })),
      remove: jest.fn(),
    };
    controller = new RfidCardsController(repository as never);
  });

  it.each([
    ['A', as.A, TOWER_A],
    ['C', as.C, TOWER_C],
  ])(
    'P acting in %s lists that building only, whatever tenantId is asked',
    async (_l, user, tenant) => {
      await controller.findAll(user, undefined, undefined, TOWER_D);
      expect(repository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: tenant } }),
      );
    },
  );

  it('the Platform context lists every building, or the one it names', async () => {
    await controller.findAll(as.platform);
    expect(repository.find).toHaveBeenLastCalledWith(expect.objectContaining({ where: {} }));
    await controller.findAll(as.platform, undefined, undefined, TOWER_B);
    expect(repository.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { tenantId: TOWER_B } }),
    );
  });

  it("a card of another building is not found, even for its person's other context", async () => {
    await expect(controller.findOne(TOWER_B, as.A)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.delete(TOWER_B, as.C)).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.remove).not.toHaveBeenCalled();

    await expect(controller.findOne(TOWER_A, as.A)).resolves.toEqual(
      expect.objectContaining({ id: TOWER_A }),
    );
    await expect(controller.findOne(TOWER_D, as.platform)).resolves.toBeDefined();
  });
});
