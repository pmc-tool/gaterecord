import { Module } from '@nestjs/common';
import { AccountIdentityClient } from './account-identity.client';

/**
 * Outbound client for the account service's identity provisioning surface.
 *
 * Lives in its own module rather than inside UsersModule because more than one
 * feature creates people who must be able to sign in (users and residents), and
 * both need the same single call path.
 */
@Module({
  providers: [AccountIdentityClient],
  exports: [AccountIdentityClient],
})
export class AccountIdentityModule {}
