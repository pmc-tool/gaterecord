import * as path from 'path';
import { DataSource, InsertEvent, RemoveEvent, SoftRemoveEvent, UpdateEvent } from 'typeorm';
import { ESLint } from 'eslint';
import { User, UserRole } from '@database/entities/user.entity';
import { ACTING_USER_MARK } from '@common/context/acting-user';
import {
  ActingUserWriteError,
  ActingUserWriteGuardSubscriber,
} from './acting-user-write-guard.subscriber';

function person(): User {
  return Object.assign(new User(), {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'p@example.test',
    role: UserRole.BUILDING_ADMIN,
    tenantId: null,
  });
}

/** What MembershipContextService builds: a clone of the person with the overlay and the mark. */
function actingUser(): User {
  const acting = Object.assign(Object.create(User.prototype), person(), {
    role: UserRole.RESIDENT,
    tenantId: '33333333-3333-4333-8333-333333333333',
    contextKind: 'membership',
    [ACTING_USER_MARK]: true,
  });
  Object.defineProperty(acting, 'activeMembership', { value: null, enumerable: false });
  return acting as User;
}

describe('ActingUserWriteGuardSubscriber', () => {
  const subscribers: unknown[] = [];
  const subscriber = new ActingUserWriteGuardSubscriber({ subscribers } as unknown as DataSource);

  const insert = (entity: unknown) =>
    subscriber.beforeInsert({ entity } as unknown as InsertEvent<User>);
  const update = (entity: unknown) =>
    subscriber.beforeUpdate({ entity } as unknown as UpdateEvent<User>);
  const remove = (entity: unknown) =>
    subscriber.beforeRemove({ entity } as unknown as RemoveEvent<User>);
  const softRemove = (entity: unknown) =>
    subscriber.beforeSoftRemove({ entity } as unknown as SoftRemoveEvent<User>);

  it('registers itself with the data source and listens to User', () => {
    expect(subscribers).toContain(subscriber);
    expect(subscriber.listenTo()).toBe(User);
  });

  it('refuses the acting user on insert, update, remove and soft-remove', () => {
    for (const operation of [insert, update, remove, softRemove]) {
      expect(() => operation(actingUser())).toThrow(ActingUserWriteError);
    }
  });

  it('refuses spread and Object.assign copies, which carry the enumerable mark', () => {
    const acting = actingUser();
    expect(() => update({ ...acting })).toThrow(ActingUserWriteError);
    expect(() => insert(Object.assign({}, acting, { email: 'x@example.test' }))).toThrow(
      ActingUserWriteError,
    );
    expect(() => update({ ...acting, role: UserRole.SUPER_ADMIN })).toThrow(ActingUserWriteError);
  });

  it('lets freshly loaded users and partial updates through', () => {
    for (const operation of [insert, update, remove, softRemove]) {
      expect(() => operation(person())).not.toThrow();
    }
    // UpdateQueryBuilder broadcasts the values being set, or nothing at all.
    expect(() => update({ status: 'active' })).not.toThrow();
    expect(() => update(undefined)).not.toThrow();
  });
});

describe('ESLint: no persisting the acting user', () => {
  const backendRoot = path.resolve(__dirname, '../../..');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require(path.join(backendRoot, '.eslintrc.js'));

  async function lint(code: string): Promise<number[]> {
    // Only the rule under test, and no type-aware parsing (the sample is not a
    // file in the TS project). The installed @types/eslint describes flat config,
    // while eslint 8 runs in eslintrc mode here, hence the cast.
    const options = {
      cwd: backendRoot,
      useEslintrc: false,
      baseConfig: {
        parser: '@typescript-eslint/parser',
        parserOptions: { sourceType: 'module', ecmaVersion: 2021 },
        rules: { 'no-restricted-syntax': config.rules['no-restricted-syntax'] },
      },
    };
    const eslint = new ESLint(options as unknown as ESLint.Options);
    const [result] = await eslint.lintText(code, {
      filePath: path.join(backendRoot, 'src/lint-sample.ts'),
    });
    return result.messages
      .filter((message) => message.ruleId === 'no-restricted-syntax')
      .map((message) => message.line);
  }

  it('flags save/update of the acting user on repositories and managers', async () => {
    const lines = await lint(
      [
        'class Sample {',
        '  a(currentUser: User) { return this.userRepository.save(currentUser); }',
        '  b(currentUser: User) { return manager.save(User, currentUser); }',
        '  c(req: any) { return this.userRepository.save(req.user); }',
        '  d(currentUser: User) { return this.userRepository.update(currentUser.id, { ...currentUser }); }',
        '  e(@CurrentUser() user: User) { return this.userRepository.save(user); }',
        '}',
      ].join('\n'),
    );
    expect(lines).toEqual([2, 3, 4, 5, 6]);
  });

  it('does not flag service calls or ordinary entity writes', async () => {
    const lines = await lint(
      [
        'class Sample {',
        '  a(currentUser: User) { return this.usersService.update(id, dto, currentUser); }',
        '  b(currentUser: User) { return this.userRepository.update({ id: currentUser.id }, { phone }); }',
        '  c() { const user = load(); return this.userRepository.save(user); }',
        "  d(@CurrentUser('id') id: string) { const user = load(); return this.userRepository.save(user); }",
        '}',
      ].join('\n'),
    );
    expect(lines).toEqual([]);
  });
});
