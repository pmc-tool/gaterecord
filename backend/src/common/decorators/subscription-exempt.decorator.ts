import { SetMetadata } from '@nestjs/common';

/**
 * Marks an AUTHENTICATED route as exempt from the SubscriptionGuard, so it keeps
 * working even when the caller's tenant subscription is inactive (SUSPENDED,
 * PENDING_PAYMENT, or paused).
 *
 * Use it on the endpoints a locked-out tenant still needs to reach in order to
 * recover — billing / checkout and onboarding — where a 402 would otherwise trap
 * the customer with no way to pay. It does NOT affect authentication: the JWT
 * guard still runs and the request must still be authenticated.
 *
 * For fully public (unauthenticated) routes use @Public() instead — the
 * SubscriptionGuard already treats @Public routes as exempt, so this decorator is
 * only needed for routes that require a logged-in user but must survive suspension.
 */
export const SUBSCRIPTION_EXEMPT_KEY = 'isSubscriptionExempt';
export const SubscriptionExempt = () => SetMetadata(SUBSCRIPTION_EXEMPT_KEY, true);
