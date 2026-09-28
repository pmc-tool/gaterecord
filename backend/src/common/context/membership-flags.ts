/**
 * The single rollout switch for multi-building memberships.
 *
 * GATE_MEMBERSHIP_CONTEXT is read ONLY through isMembershipContextEnabled().
 * Nothing else in the codebase reads process.env.GATE_MEMBERSHIP_CONTEXT, so the
 * flag has exactly one meaning and one place to change it.
 *
 *   'on'                 requests act as the membership chosen with the
 *                        X-Gate-Membership header, GET /memberships/me is live,
 *                        gate credentials are checked against memberships, and a
 *                        person may hold roles in several buildings.
 *   anything else/unset  today's single-building behaviour: req.user is the
 *                        gate_users row (the "legacy" overlay), /memberships/me
 *                        answers 404, credential checks compare the holder's
 *                        gate_users.tenant_id and status, and adding a second
 *                        live membership for a person is refused with
 *                        409 MULTI_MEMBERSHIP_DISABLED.
 *
 * Read on every call rather than cached at boot, so a test can flip it per case
 * and there is no second copy of the value to drift from the environment.
 * Deliberately strict: only the exact value 'on' enables it, so a typo leaves
 * the system in the safe legacy mode.
 */
export const GATE_MEMBERSHIP_CONTEXT_ENV = 'GATE_MEMBERSHIP_CONTEXT';

export function isMembershipContextEnabled(): boolean {
  return (process.env[GATE_MEMBERSHIP_CONTEXT_ENV] ?? '').trim() === 'on';
}
