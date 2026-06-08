import { handleError, useTRPC } from '@/integrations/trpc/react';
import { useMutation } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

// Per-organization SSO sign-in.
//
// On click the button reveals an inline email input. On submit, calls
// `auth.signInOAuth({ provider: 'org-sso', email })` — the server
// resolves the routing OrganizationSsoConfig by email domain and
// redirects to that Org's IdP. If no Org claims the domain, the
// server returns a 403 "no SSO configured for this email" and we
// surface that as an inline error so the user can pick another
// provider.
//
// We intentionally don't pre-resolve "does this email have SSO?" via
// a separate endpoint — that would leak which domains are
// SSO-configured to anyone who could send an email. Letting the
// signInOAuth mutation handle the lookup keeps the surface to one
// call.
export function SignInOrgSso({
  type,
  inviteId,
}: {
  type: 'sign-in' | 'sign-up';
  inviteId?: string;
}) {
  const trpc = useTRPC();
  const [expanded, setExpanded] = useState(false);
  const [email, setEmail] = useState('');

  const mutation = useMutation(
    trpc.auth.signInOAuth.mutationOptions({
      onSuccess(res) {
        if (res.url) {
          window.location.href = res.url;
        }
      },
      onError: handleError,
    }),
  );

  if (!expanded) {
    return (
      <Button
        className="w-full border border-def-300 bg-background text-foreground shadow-sm transition-all duration-200 hover:bg-def-100 hover:shadow-md [&_svg]:shrink-0"
        onClick={() => setExpanded(true)}
        size="lg"
        type="button"
      >
        <Building2 className="mr-2 size-4" />
        {type === 'sign-in'
          ? 'Sign in with your organization'
          : 'Sign up with your organization'}
      </Button>
    );
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!email) return;
        mutation.mutate({
          provider: 'org-sso',
          email,
          inviteId: type === 'sign-up' ? inviteId : undefined,
        });
      }}
    >
      <Input
        type="email"
        placeholder="you@your-org.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoFocus
        autoComplete="email"
        required
      />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => setExpanded(false)}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="flex-1"
          disabled={mutation.isPending || !email}
        >
          {mutation.isPending ? 'Redirecting…' : 'Continue'}
        </Button>
      </div>
    </form>
  );
}
