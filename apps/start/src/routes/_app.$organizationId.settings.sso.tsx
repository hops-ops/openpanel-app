import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import TagInput from '@/components/forms/tag-input';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Widget, WidgetBody, WidgetHead } from '@/components/widget';
import { handleError, useTRPC } from '@/integrations/trpc/react';
import { PAGE_TITLES, createOrganizationTitle } from '@/utils/title';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';

// Path: /:organizationId/settings/sso — org-admin-only SSO config UI.
//
// Form shape mirrors the tRPC `organizationSso.upsert` input. The
// client_secret field is write-only — when a secret is already
// stored, `placeholder="••••••••"` and an empty submission leaves
// the stored value unchanged.

interface FormValues {
  displayName: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcAuthorizationEndpoint: string;
  oidcTokenEndpoint: string;
  oidcJwksUri: string;
  enforcedForDomains: string[];
  isRequired: boolean;
}

export const Route = createFileRoute('/_app/$organizationId/settings/sso')({
  component: Component,
  head: () => ({
    meta: [{ title: createOrganizationTitle(PAGE_TITLES.SETTINGS) }],
  }),
});

function Component() {
  const { organizationId } = Route.useParams();
  const trpc = useTRPC();

  const cfgQuery = useQuery(
    trpc.organizationSso.get.queryOptions({ organizationId }),
  );
  const statusQuery = useQuery(
    trpc.organizationSso.status.queryOptions({ organizationId }),
  );

  if (cfgQuery.isLoading || statusQuery.isLoading) {
    return <FullPageLoadingState />;
  }

  const config = cfgQuery.data ?? null;
  const cryptoConfigured = statusQuery.data?.cryptoConfigured ?? false;

  return (
    <div className="container p-8">
      <PageHeader
        title="Single Sign-On"
        description="Configure an OIDC identity provider for everyone in this organization."
        className="mb-8"
      />

      {!cryptoConfigured && (
        <Widget className="mb-6">
          <WidgetHead>
            <span className="title">SSO encryption key not configured</span>
          </WidgetHead>
          <WidgetBody>
            <p className="text-sm text-muted-foreground">
              The api server is missing the <code>SSO_CONFIG_ENCRYPTION_KEY</code>{' '}
              environment variable. Ask your operator to generate one
              (<code>openssl rand -base64 32</code>) before saving an SSO
              config — without it, client secrets cannot be encrypted at rest.
            </p>
          </WidgetBody>
        </Widget>
      )}

      <SsoForm
        organizationId={organizationId}
        config={config}
        disabled={!cryptoConfigured}
        onSaved={() => {
          cfgQuery.refetch();
        }}
      />

      {config && (
        <DeleteSection
          organizationId={organizationId}
          onDeleted={() => cfgQuery.refetch()}
        />
      )}
    </div>
  );
}

function SsoForm({
  organizationId,
  config,
  disabled,
  onSaved,
}: {
  organizationId: string;
  config:
    | (NonNullable<
        ReturnType<typeof useGetQuery>['data']
      > & {})
    | null;
  disabled: boolean;
  onSaved: () => void;
}) {
  const trpc = useTRPC();
  const hasSecret = !!config?.hasOidcClientSecret;

  const { register, handleSubmit, formState, reset, control } = useForm<FormValues>({
    defaultValues: {
      displayName: config?.displayName ?? 'Single Sign-On',
      oidcClientId: config?.oidcClientId ?? '',
      oidcClientSecret: '',
      oidcAuthorizationEndpoint: config?.oidcAuthorizationEndpoint ?? '',
      oidcTokenEndpoint: config?.oidcTokenEndpoint ?? '',
      oidcJwksUri: config?.oidcJwksUri ?? '',
      enforcedForDomains: config?.enforcedForDomains ?? [],
      isRequired: config?.isRequired ?? false,
    },
  });

  const mutation = useMutation(
    trpc.organizationSso.upsert.mutationOptions({
      onSuccess: (res) => {
        toast('SSO config saved', {
          description: 'Test the flow before flipping "Require SSO".',
        });
        reset({
          displayName: res.displayName,
          oidcClientId: res.oidcClientId ?? '',
          oidcClientSecret: '',
          oidcAuthorizationEndpoint: res.oidcAuthorizationEndpoint ?? '',
          oidcTokenEndpoint: res.oidcTokenEndpoint ?? '',
          oidcJwksUri: res.oidcJwksUri ?? '',
          enforcedForDomains: res.enforcedForDomains,
          isRequired: res.isRequired,
        });
        onSaved();
      },
      onError: handleError,
    }),
  );

  return (
    <form
      onSubmit={handleSubmit((values) => {
        mutation.mutate({
          organizationId,
          provider: 'OIDC',
          displayName: values.displayName,
          oidcClientId: values.oidcClientId,
          oidcClientSecret: values.oidcClientSecret || undefined,
          oidcAuthorizationEndpoint: values.oidcAuthorizationEndpoint,
          oidcTokenEndpoint: values.oidcTokenEndpoint,
          oidcJwksUri: values.oidcJwksUri || undefined,
          enforcedForDomains: values.enforcedForDomains,
          isRequired: values.isRequired,
        });
      })}
    >
      <Widget>
        <WidgetHead>
          <span className="title">OIDC Provider</span>
        </WidgetHead>
        <WidgetBody className="gap-4 col">
          <InputWithLabel
            label="Display name"
            placeholder="e.g. Acme SSO"
            {...register('displayName')}
          />
          <InputWithLabel
            label="Client ID"
            placeholder="OIDC client_id issued by your IdP"
            {...register('oidcClientId')}
          />
          <InputWithLabel
            label="Client secret"
            type="password"
            autoComplete="off"
            placeholder={hasSecret ? '•••••••• (leave blank to keep existing)' : 'OIDC client_secret'}
            {...register('oidcClientSecret')}
          />
          <InputWithLabel
            label="Authorization endpoint"
            placeholder="https://auth.example.com/oauth/v2/authorize"
            {...register('oidcAuthorizationEndpoint')}
          />
          <InputWithLabel
            label="Token endpoint"
            placeholder="https://auth.example.com/oauth/v2/token"
            {...register('oidcTokenEndpoint')}
          />
          <InputWithLabel
            label="JWKS URI (optional)"
            placeholder="https://auth.example.com/oauth/v2/keys"
            {...register('oidcJwksUri')}
          />

          <Controller
            name="enforcedForDomains"
            control={control}
            render={({ field }) => (
              <WithLabel label="Email domains routed to this SSO">
                <TagInput
                  placeholder="acme.com (Enter to add)"
                  value={field.value}
                  onChange={field.onChange}
                />
              </WithLabel>
            )}
          />

          <Controller
            name="isRequired"
            control={control}
            render={({ field }) => (
              <div className="flex items-start justify-between gap-4 rounded-md border p-4">
                <div>
                  <div className="font-medium">Require SSO</div>
                  <div className="text-sm text-muted-foreground">
                    When enabled, members of this organization cannot sign in
                    with email + password. Test the flow first.
                  </div>
                </div>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </div>
            )}
          />

          <Button
            size="sm"
            type="submit"
            disabled={disabled || !formState.isDirty || mutation.isPending}
            className="self-end"
          >
            {config ? 'Save' : 'Configure SSO'}
          </Button>
        </WidgetBody>
      </Widget>
    </form>
  );
}

function DeleteSection({
  organizationId,
  onDeleted,
}: {
  organizationId: string;
  onDeleted: () => void;
}) {
  const trpc = useTRPC();
  const mutation = useMutation(
    trpc.organizationSso.delete.mutationOptions({
      onSuccess: () => {
        toast('SSO config removed');
        onDeleted();
      },
      onError: handleError,
    }),
  );
  return (
    <Widget className="mt-6">
      <WidgetHead>
        <span className="title text-destructive">Danger zone</span>
      </WidgetHead>
      <WidgetBody>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">Remove SSO configuration</div>
            <div className="text-sm text-muted-foreground">
              Members of this organization will be able to sign in with email
              and password again.
            </div>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => mutation.mutate({ organizationId })}
            disabled={mutation.isPending}
          >
            Delete
          </Button>
        </div>
      </WidgetBody>
    </Widget>
  );
}

// helper to derive the query's data type without redeclaring it inline
function useGetQuery() {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizationSso.get.queryOptions({ organizationId: '' }),
  );
}
