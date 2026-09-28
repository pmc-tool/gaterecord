import {
  ACTING_USER_MARK,
  GATE_MEMBERSHIP_HEADER,
  contextKindOf,
  isActingUser,
  parseMembershipHeader,
  readMembershipHeader,
} from './acting-user';
import { isMembershipContextEnabled } from './membership-flags';
import {
  MembershipErrorCode,
  membershipErrorCodeOf,
  membershipExists,
  multiMembershipDisabled,
} from './membership-context.errors';

const ID = '0E5B2C9A-3F4D-4B8E-9A1C-2D3E4F5A6B7C';

describe('parseMembershipHeader', () => {
  it('treats missing and blank values as absent', () => {
    expect(parseMembershipHeader(undefined)).toEqual({ kind: 'absent' });
    expect(parseMembershipHeader(null)).toEqual({ kind: 'absent' });
    expect(parseMembershipHeader('   ')).toEqual({ kind: 'absent' });
  });

  it("recognises the literal 'platform'", () => {
    expect(parseMembershipHeader('platform')).toEqual({ kind: 'platform' });
    expect(parseMembershipHeader(' Platform ')).toEqual({ kind: 'platform' });
  });

  it('accepts a uuid and lower-cases it', () => {
    expect(parseMembershipHeader(ID)).toEqual({
      kind: 'membership',
      membershipId: ID.toLowerCase(),
    });
  });

  it('never lets anything else through to a query', () => {
    for (const value of [
      [ID],
      [ID, ID],
      `${ID}, ${ID}`,
      'not-a-uuid',
      `${ID}' OR 1=1 --`,
      42,
      {},
    ]) {
      expect(parseMembershipHeader(value)).toEqual({ kind: 'malformed' });
    }
  });
});

describe('readMembershipHeader', () => {
  it('reads the lower-case header Node exposes', () => {
    expect(readMembershipHeader({ headers: { [GATE_MEMBERSHIP_HEADER]: ID } })).toBe(ID);
    expect(readMembershipHeader({ headers: {} })).toBeUndefined();
    expect(readMembershipHeader(undefined)).toBeUndefined();
  });
});

describe('isActingUser / contextKindOf', () => {
  it('recognises the mark, including on spread copies', () => {
    const acting = { id: 'x', [ACTING_USER_MARK]: true as const };
    expect(isActingUser(acting)).toBe(true);
    expect(isActingUser({ ...acting })).toBe(true);
    expect(isActingUser({ id: 'x' })).toBe(false);
    expect(isActingUser(null)).toBe(false);
  });

  it('treats a principal without contextKind as legacy', () => {
    expect(contextKindOf({})).toBe('legacy');
    expect(contextKindOf(undefined)).toBe('legacy');
    expect(contextKindOf({ contextKind: 'none' })).toBe('none');
  });
});

describe('isMembershipContextEnabled', () => {
  const original = process.env.GATE_MEMBERSHIP_CONTEXT;
  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = original;
  });

  it("is on only for the exact value 'on'", () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    expect(isMembershipContextEnabled()).toBe(true);

    for (const value of ['off', 'true', '1', 'yes', 'ON', '']) {
      process.env.GATE_MEMBERSHIP_CONTEXT = value;
      expect(isMembershipContextEnabled()).toBe(false);
    }

    delete process.env.GATE_MEMBERSHIP_CONTEXT;
    expect(isMembershipContextEnabled()).toBe(false);
  });
});

describe('membership error bodies', () => {
  it('put code at the top level, like SUBSCRIPTION_INACTIVE', () => {
    const exists = membershipExists('resident');
    expect(exists.getStatus()).toBe(409);
    expect(exists.getResponse()).toMatchObject({
      code: 'MEMBERSHIP_EXISTS',
      role: 'resident',
      message: expect.any(String),
    });
    expect(membershipErrorCodeOf(exists)).toBe(MembershipErrorCode.MEMBERSHIP_EXISTS);
    expect(membershipErrorCodeOf(multiMembershipDisabled())).toBe('MULTI_MEMBERSHIP_DISABLED');
    expect(membershipErrorCodeOf(new Error('x'))).toBeNull();
  });
});
