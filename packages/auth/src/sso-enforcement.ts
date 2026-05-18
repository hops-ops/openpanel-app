// ---------------------------------------------------------------------------
// Per-organization SSO enforcement.
//
// `isSsoRequiredForUser(userId)` reports whether the user belongs to
// any Organization with `OrganizationSsoConfig.isRequired = true`.
// Used by the email/password sign-in path to refuse a non-SSO sign-in
// for members of organizations that mandate SSO.
//
// Returns the first matching `OrganizationSsoConfig` so the caller can
// surface "your organization requires SSO" with a link that kicks off
// the right flow (the email-domain that routes to that Org).
// ---------------------------------------------------------------------------

import { db, type OrganizationSsoConfig } from '@openpanel/db';

export async function isSsoRequiredForUser(
  userId: string,
): Promise<OrganizationSsoConfig | null> {
  const match = await db.member.findFirst({
    where: {
      userId,
      organization: {
        ssoConfig: {
          isRequired: true,
        },
      },
    },
    include: {
      organization: {
        include: {
          ssoConfig: true,
        },
      },
    },
  });
  return match?.organization?.ssoConfig ?? null;
}
