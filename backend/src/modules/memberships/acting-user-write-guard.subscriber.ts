import { Injectable } from '@nestjs/common';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  RemoveEvent,
  SoftRemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { User } from '@database/entities/user.entity';
import { ACTING_USER_MARK } from '@common/context/acting-user';

/** Thrown when code tries to persist the overlaid principal. A bug, never a client error. */
export class ActingUserWriteError extends Error {
  constructor(operation: string) {
    super(
      `Refusing to ${operation} the acting user (req.user). It carries the chosen ` +
        "membership's role and building on top of the person; saving it would write " +
        'them into gate_users. Load the person with a repository and save that instead.',
    );
    this.name = 'ActingUserWriteError';
  }
}

function carriesMark(entity: unknown): boolean {
  return (
    typeof entity === 'object' &&
    entity !== null &&
    (entity as Record<symbol, unknown>)[ACTING_USER_MARK] === true
  );
}

/**
 * Refuses to insert, update, remove or soft-remove a User that is really the
 * overlaid acting principal (contract C5), or a spread / Object.assign copy of
 * it: ACTING_USER_MARK is an enumerable own symbol, so copies carry it too.
 *
 * Without this, `userRepository.save(currentUser)` (or `update(id, {...user})`)
 * would persist the ACTIVE building's role, tenant and unit into the person's
 * legacy columns, or demote a super admin acting in a building. Freshly loaded
 * User entities never carry the mark and pass untouched.
 *
 * Registers itself with the DataSource in its constructor (the NestJS pattern
 * for DI-created subscribers), so it applies to every EntityManager, repository
 * and transaction of that connection.
 */
@Injectable()
export class ActingUserWriteGuardSubscriber implements EntitySubscriberInterface<User> {
  constructor(dataSource: DataSource) {
    dataSource.subscribers.push(this);
  }

  listenTo() {
    return User;
  }

  beforeInsert(event: InsertEvent<User>): void {
    this.refuse(event.entity, 'insert');
  }

  beforeUpdate(event: UpdateEvent<User>): void {
    this.refuse(event.entity, 'update');
  }

  beforeRemove(event: RemoveEvent<User>): void {
    this.refuse(event.entity, 'remove');
  }

  beforeSoftRemove(event: SoftRemoveEvent<User>): void {
    this.refuse(event.entity, 'soft-remove');
  }

  private refuse(entity: unknown, operation: string): void {
    if (carriesMark(entity)) {
      throw new ActingUserWriteError(operation);
    }
  }
}
