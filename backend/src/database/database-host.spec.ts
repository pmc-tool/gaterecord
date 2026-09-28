import {
  databaseHostOf,
  describeDatabaseUrl,
  isLocalDatabaseUrl,
  resolveSynchronize,
} from './database-host';

const STAGING = 'postgresql://user:secret@192.168.200.103:5432/gate_management_staging';

describe('database host guard', () => {
  it('recognises the local hosts only', () => {
    for (const url of [
      'postgres://u:p@localhost:5432/gate',
      'postgres://u:p@127.0.0.1:5432/gate',
      'postgres://u:p@[::1]:5432/gate',
      'postgresql://postgres:password@gate_postgres:5432/gate_management',
      'postgres://u:p@LOCALHOST/gate',
    ]) {
      expect(isLocalDatabaseUrl(url)).toBe(true);
    }

    for (const url of [STAGING, 'postgres://u:p@db.example.com/gate', 'not a url', '', undefined]) {
      expect(isLocalDatabaseUrl(url)).toBe(false);
    }
  });

  it('reads the host and never prints credentials', () => {
    expect(databaseHostOf(STAGING)).toBe('192.168.200.103');
    expect(describeDatabaseUrl(STAGING)).toBe('192.168.200.103:5432/gate_management_staging');
    expect(describeDatabaseUrl(STAGING)).not.toContain('secret');
  });

  it('keeps synchronize off against a remote database unless ALLOW_REMOTE_SYNC is set', () => {
    expect(resolveSynchronize({ wanted: true, url: STAGING, allowRemoteSync: false })).toEqual({
      synchronize: false,
      refusedReason: expect.stringContaining('not a local database'),
    });
    expect(
      resolveSynchronize({ wanted: true, url: STAGING, allowRemoteSync: true }).synchronize,
    ).toBe(true);
    expect(
      resolveSynchronize({
        wanted: true,
        url: 'postgres://u:p@localhost/gate',
        allowRemoteSync: false,
      }),
    ).toEqual({ synchronize: true, refusedReason: null });
    expect(
      resolveSynchronize({
        wanted: false,
        url: 'postgres://u:p@localhost/gate',
        allowRemoteSync: true,
      }),
    ).toEqual({ synchronize: false, refusedReason: null });
  });
});
