import { describe, expect, it, vi } from 'vitest';

const findFirst = vi.hoisted(() => vi.fn());

vi.mock('@openpanel/db', () => ({
  db: {
    organizationSsoConfig: { findFirst },
  },
}));

// Import AFTER the mock is set up so the helper picks up our stub.
const { emailDomain, lookupOrgSsoByEmailDomain } = await import('./src/sso-lookup');

describe('emailDomain', () => {
  it('extracts the lowercased domain', () => {
    expect(emailDomain('Pat@Example.COM')).toBe('example.com');
  });

  it('returns null for malformed inputs', () => {
    expect(emailDomain('')).toBeNull();
    expect(emailDomain('not-an-email')).toBeNull();
    expect(emailDomain('@example.com')).toBeNull();
    expect(emailDomain('pat@')).toBeNull();
    expect(emailDomain('pat@no-tld')).toBeNull();
    expect(emailDomain('pat @example.com')).toBeNull();
    // @ts-expect-error testing the non-string path
    expect(emailDomain(undefined)).toBeNull();
  });

  it('handles plus addressing', () => {
    expect(emailDomain('pat+tag@example.com')).toBe('example.com');
  });
});

describe('lookupOrgSsoByEmailDomain', () => {
  it('returns null when no SSO config matches the domain', async () => {
    findFirst.mockResolvedValueOnce(null);
    const result = await lookupOrgSsoByEmailDomain('pat@example.com');
    expect(result).toBeNull();
    expect(findFirst).toHaveBeenLastCalledWith({
      where: { enforcedForDomains: { has: 'example.com' } },
      include: { organization: true },
    });
  });

  it('returns null for malformed emails without hitting the DB', async () => {
    findFirst.mockReset();
    const result = await lookupOrgSsoByEmailDomain('not-an-email');
    expect(result).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('separates the included organization from the config row', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'cfg-1',
      organizationId: 'org-1',
      provider: 'OIDC',
      organization: { id: 'org-1', name: 'Acme' },
    });
    const result = await lookupOrgSsoByEmailDomain('pat@acme.com');
    expect(result).not.toBeNull();
    expect(result!.organization).toEqual({ id: 'org-1', name: 'Acme' });
    // organization should be stripped from the config payload itself
    expect((result!.config as unknown as { organization?: unknown }).organization).toBeUndefined();
    expect(result!.config.organizationId).toBe('org-1');
  });
});
