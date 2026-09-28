/**
 * Whether gate_memberships exists in the connected database, as the boot check
 * of MembershipsModule found it.
 *
 * With GATE_MEMBERSHIP_CONTEXT off, authentication and the gate holder check
 * must keep working on a database where migration 1775740000000 has not run
 * yet. The two legacy readers that also consult gate_memberships as a rollback
 * safety net (the legacy overlay in MembershipContextService and the legacy
 * holder check in MembershipAccessService: "the membership in the person's
 * legacy building is not active") therefore do so only once the boot check has
 * SEEN the table. Before that, and in specs that never boot the module, they
 * behave exactly as they did before memberships existed.
 *
 * The table is looked up once, at boot: a migration run while the backend is
 * up takes effect for these two readers at the next restart.
 */
let membershipTablePresent = false;

export function isMembershipTableKnownPresent(): boolean {
  return membershipTablePresent;
}

/** Set by MembershipsModule's boot check (and by database suites). */
export function recordMembershipTablePresence(present: boolean): void {
  membershipTablePresent = present;
}
