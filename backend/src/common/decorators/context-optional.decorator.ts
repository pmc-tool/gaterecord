import { SetMetadata } from '@nestjs/common';

/**
 * Marks an AUTHENTICATED route (or a whole controller) as not needing a building
 * context: it works for a person who has not chosen a membership yet, has none,
 * or sent a stale X-Gate-Membership header.
 *
 * On such a route JwtAuthGuard does not answer 409 MEMBERSHIP_REQUIRED or
 * 403 MEMBERSHIP_INVALID; req.user is still authenticated and may be in the
 * 'none' context (role and tenantId null), and an invalid header is ignored.
 * It also implies @SubscriptionExempt(): a route that does not act in a building
 * cannot be read-only-graced by that building's subscription.
 *
 * Reserved for person-level routes (profile, notifications, settings, onboarding,
 * join requests, /memberships/me). The route list is fixed by the contract; do
 * not add it elsewhere without updating that list and its test
 * (common/guards/context-optional-routes.spec.ts). Read with
 * Reflector.getAllAndOverride(CONTEXT_OPTIONAL_KEY, [handler, class]).
 */
export const CONTEXT_OPTIONAL_KEY = 'gateContextOptional';
export const ContextOptional = () => SetMetadata(CONTEXT_OPTIONAL_KEY, true);

/**
 * Opts ONE handler of a @ContextOptional() controller back into requiring a
 * building context. getAllAndOverride reads the handler before the class, so
 * this `false` wins over the class-level `true`.
 *
 * Used where every route of a controller is person-level except one that acts
 * in the chosen building, e.g. POST /resident-join/leave, which ends the
 * resident membership named by the header.
 */
export const ContextRequired = () => SetMetadata(CONTEXT_OPTIONAL_KEY, false);
