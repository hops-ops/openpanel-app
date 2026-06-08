-- CreateEnum
CREATE TYPE "sso_provider" AS ENUM ('OIDC');

-- CreateTable
CREATE TABLE "organization_sso_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" TEXT NOT NULL,
    "provider" "sso_provider" NOT NULL DEFAULT 'OIDC',
    "displayName" TEXT NOT NULL DEFAULT 'Single Sign-On',
    "oidcClientId" TEXT,
    "oidcClientSecretEncrypted" BYTEA,
    "oidcAuthorizationEndpoint" TEXT,
    "oidcTokenEndpoint" TEXT,
    "oidcJwksUri" TEXT,
    "enforcedForDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_sso_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (1:1 with Organization)
CREATE UNIQUE INDEX "organization_sso_configs_organizationId_key" ON "organization_sso_configs"("organizationId");

-- CreateIndex (GIN over the text[] for email-domain lookup at sign-in time)
CREATE INDEX "organization_sso_configs_enforcedForDomains_idx" ON "organization_sso_configs" USING GIN ("enforcedForDomains");

-- AddForeignKey
ALTER TABLE "organization_sso_configs" ADD CONSTRAINT "organization_sso_configs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
