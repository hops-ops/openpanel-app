// ---------------------------------------------------------------------------
// Per-organization SSO admin procedures.
//
// Operators of an Organization manage the OrganizationSsoConfig row
// via these procedures. Authorization: `org:admin` role required on
// the target organization (same gate as `organization.update`,
// `invite`, etc.).
//
// The plaintext OIDC client secret is accepted on write but NEVER
// echoed back on read — `get` strips the encrypted blob entirely and
// reports only whether a secret is set. Rotating the secret requires
// posting a fresh value via `upsert`.
//
// Spec: specs/openpanel-sso-instance-and-per-org
// ---------------------------------------------------------------------------

import { encryptSsoSecret, isSsoCryptoConfigured } from '@openpanel/auth';
import { db, type OrganizationSsoConfig } from '@openpanel/db';
import { z } from 'zod';

import { getOrganizationAccess } from '../access';
import { TRPCAccessError, TRPCBadRequestError } from '../errors';
import { createTRPCRouter, protectedProcedure } from '../trpc';

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const zUrl = z.string().url();
// Domain shape: lowercased labels, dot-separated, no scheme/path.
const zDomain = z
  .string()
  .min(3)
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i,
    'must be a bare DNS domain (no scheme, no path)',
  )
  .transform((s) => s.toLowerCase());

const zUpsertInput = z.object({
  organizationId: z.string(),
  provider: z.literal('OIDC').default('OIDC'),
  displayName: z.string().min(1).max(120).default('Single Sign-On'),
  oidcClientId: z.string().min(1),
  // Optional on update: omit to keep the existing secret. Required on
  // first-time create (the upsert handler enforces this below).
  oidcClientSecret: z.string().min(1).optional(),
  oidcAuthorizationEndpoint: zUrl,
  oidcTokenEndpoint: zUrl,
  oidcJwksUri: zUrl.optional(),
  enforcedForDomains: z.array(zDomain).default([]),
  isRequired: z.boolean().default(false),
});

// Shape returned to the admin UI. The encrypted blob never leaves
// the api process; report only a boolean so the form can render
// "secret is set" vs "no secret".
type PublicConfig = Omit<OrganizationSsoConfig, 'oidcClientSecretEncrypted'> & {
  hasOidcClientSecret: boolean;
};

function toPublic(config: OrganizationSsoConfig): PublicConfig {
  const { oidcClientSecretEncrypted, ...rest } = config;
  return {
    ...rest,
    hasOidcClientSecret: !!oidcClientSecretEncrypted,
  };
}

async function requireAdmin(userId: string, organizationId: string) {
  const access = await getOrganizationAccess({ userId, organizationId });
  if (access?.role !== 'org:admin') {
    throw TRPCAccessError('You must be an organization admin to manage SSO');
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const organizationSsoRouter = createTRPCRouter({
  // Returns null when no config exists. The form on the dashboard
  // treats `null` as "first-time setup" and `non-null` as "edit".
  get: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .query(async ({ input, ctx }) => {
      await requireAdmin(ctx.session.userId, input.organizationId);
      const config = await db.organizationSsoConfig.findUnique({
        where: { organizationId: input.organizationId },
      });
      return config ? toPublic(config) : null;
    }),

  // Reports whether `SSO_CONFIG_ENCRYPTION_KEY` is set on the api
  // pod. The dashboard surfaces this so admins see "your operator
  // needs to set the encryption key before you can configure SSO"
  // rather than getting a confusing throw on first save.
  status: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .query(async ({ input, ctx }) => {
      await requireAdmin(ctx.session.userId, input.organizationId);
      return {
        cryptoConfigured: isSsoCryptoConfigured(),
      };
    }),

  upsert: protectedProcedure
    .input(zUpsertInput)
    .mutation(async ({ input, ctx }) => {
      await requireAdmin(ctx.session.userId, input.organizationId);
      if (!isSsoCryptoConfigured()) {
        throw TRPCBadRequestError(
          'SSO_CONFIG_ENCRYPTION_KEY is not set on the api pod. The operator must configure it before saving an SSO config.',
        );
      }

      const existing = await db.organizationSsoConfig.findUnique({
        where: { organizationId: input.organizationId },
      });

      if (!existing && !input.oidcClientSecret) {
        throw TRPCBadRequestError(
          'oidcClientSecret is required when creating a new SSO config',
        );
      }

      const data = {
        provider: input.provider,
        displayName: input.displayName,
        oidcClientId: input.oidcClientId,
        oidcAuthorizationEndpoint: input.oidcAuthorizationEndpoint,
        oidcTokenEndpoint: input.oidcTokenEndpoint,
        oidcJwksUri: input.oidcJwksUri ?? null,
        enforcedForDomains: input.enforcedForDomains,
        isRequired: input.isRequired,
        ...(input.oidcClientSecret
          ? {
              oidcClientSecretEncrypted: encryptSsoSecret(
                input.oidcClientSecret,
              ),
            }
          : {}),
      };

      const config = await db.organizationSsoConfig.upsert({
        where: { organizationId: input.organizationId },
        create: {
          organizationId: input.organizationId,
          createdByUserId: ctx.session.userId,
          ...data,
        },
        update: data,
      });
      return toPublic(config);
    }),

  delete: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireAdmin(ctx.session.userId, input.organizationId);
      await db.organizationSsoConfig.deleteMany({
        where: { organizationId: input.organizationId },
      });
      return { ok: true };
    }),
});
