import { UserRole } from '@database/entities/user.entity';
import { MEMBERSHIP_ROLES, MembershipRole } from '@database/entities/membership.entity';

/**
 * Which building roles each kind of access decision accepts. One line each, so a
 * product decision (open question A3 and friends) is a one-line change here and
 * nowhere else. Every set is checked against the holder's ACTIVE membership in
 * the credential's building (MembershipAccessService.checkHolder).
 *
 * The defaults reproduce today's rules: the gate never looked at the holder's
 * role, only at their building (and, for QR, their status), so the credential
 * sets accept every building role. Issuing a personal card was the one place a
 * role was required (resident).
 */

/** Personal QR code (gate_users.qr_code): any active role opens the gate. */
export const PERSONAL_QR_ROLES: readonly MembershipRole[] = MEMBERSHIP_ROLES;

/** A personal RFID card held by a person (rfid_cards.user_id). */
export const CARD_HOLDER_ROLES: readonly MembershipRole[] = MEMBERSHIP_ROLES;

/** The owner of a vehicle whose tag or card is scanned. */
export const VEHICLE_OWNER_ROLES: readonly MembershipRole[] = MEMBERSHIP_ROLES;

/** Who may be issued a new personal RFID card at registration. */
export const CARD_ISSUE_ROLES: readonly MembershipRole[] = [UserRole.RESIDENT];

/** Who receives a building's security alerts and staff notifications (plus super admins). */
export const ALERT_RECIPIENT_ROLES: readonly MembershipRole[] = [
  UserRole.BUILDING_ADMIN,
  UserRole.SECURITY,
];

/** Who may join a building's staff socket room (tenant:{id}) for the live operations feed. */
export const STAFF_ROOM_ROLES: readonly MembershipRole[] = [
  UserRole.BUILDING_ADMIN,
  UserRole.SECURITY,
  UserRole.STAFF,
];

/**
 * Who sees every visitor pass of the building; any other role sees only the
 * passes it created or hosts. Compared with the overlaid req.user.role, so it
 * includes super_admin (the Platform context).
 */
export const STAFF_PASS_ROLES: readonly UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.BUILDING_ADMIN,
  UserRole.SECURITY,
];
