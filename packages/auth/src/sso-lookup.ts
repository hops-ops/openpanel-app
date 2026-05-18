// ---------------------------------------------------------------------------
// Per-organization SSO lookup.
//
// Given an email, resolve the OrganizationSsoConfig (and owning
// Organization) whose `enforcedForDomains` array contains the email's
// domain. Used by:
//
//   1. `/login` email-domain routing (UI hint or auto-redirect when
//      `isRequired = true`)
//   2. tRPC `signInOAuth` with `provider: 'org-sso'` — picks the IdP
//      to redirect to
//   3. The OIDC callback's pre-flight check (the state cookie carries
//      `ssoConfigId` directly; this helper is for the lookup path)
//
// Returns `null` for any input we can't route — no match, malformed
// email, anonymous caller. Callers should fall through to the
// instance-level OIDC flow (env-driven) when this returns null.
// ---------------------------------------------------------------------------

import { type Organization, type OrganizationSsoConfig, db } from '@openpanel/db';

export interface OrgSsoLookupResult {
  config: OrganizationSsoConfig;
  organization: Organization;
}

/**
 * Extract the lowercased domain from an email. Returns `null` for
 * inputs that don't look like a single-@ email — we don't try to
 * parse exotic addresses (quoted local-parts, IP literals, plus
 * addressing on the domain side).
 */
export function emailDomain(email: string): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return null;
  // No internal whitespace anywhere (`pat @example.com` is malformed
  // even though split('@')[1] would otherwise pass).
  if (/\s/.test(trimmed)) return null;
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return null;
  const domain = trimmed.slice(atIdx + 1);
  // Cheap sanity check — at least one dot.
  if (!domain.includes('.')) return null;
  return domain;
}

/**
 * Lookup the SSO config (if any) that an email's domain routes to.
 *
 * Returns `null` if no Org has the domain in `enforcedForDomains`,
 * or if the email is malformed. Does NOT throw on DB errors that
 * could plausibly be transient — callers must treat null as "no
 * SSO route for this address, fall through to other providers".
 */
export async function lookupOrgSsoByEmailDomain(
  email: string,
): Promise<OrgSsoLookupResult | null> {
  const domain = emailDomain(email);
  if (!domain) return null;

  const config = await db.organizationSsoConfig.findFirst({
    where: {
      enforcedForDomains: { has: domain },
    },
    include: { organization: true },
  });

  if (!config) return null;
  const { organization, ...rest } = config;
  return { config: rest, organization };
}
