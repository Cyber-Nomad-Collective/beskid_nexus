import { useState } from 'react';
import { Sparkles } from '@/lib/lucide-icons';
import { submitOAuthSetup } from '../services/nexus-api';

interface OAuthSetupWizardProps {
  onComplete: () => void;
}

export function OAuthSetupWizard({ onComplete }: OAuthSetupWizardProps) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [callbackUrl, setCallbackUrl] = useState(
    () => `${window.location.origin}/api/auth/callback`,
  );
  const [ownerLogin, setOwnerLogin] = useState('');
  const [adminLogins, setAdminLogins] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await submitOAuthSetup({
        githubClientId: clientId,
        githubClientSecret: clientSecret,
        githubOAuthCallbackUrl: callbackUrl,
        ownerLogin,
        adminLogins: adminLogins || ownerLogin,
        setupToken: setupToken || undefined,
      });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative mx-auto max-w-lg animate-fade-in overflow-hidden rounded-3xl border border-border-default bg-surface p-7">
      <div className="pointer-events-none absolute -top-28 -right-28 h-72 w-72 rounded-full bg-accent/6 blur-3xl" />
      <div className="relative mb-6 text-center">
        <Sparkles className="mx-auto mb-3 h-8 w-8 text-accent" />
        <h1 className="text-lg font-semibold text-text-primary">Configure GitHub OAuth</h1>
        <p className="mt-2 text-sm text-text-secondary">
          Create a GitHub OAuth App and enter its credentials so admins can sign in and manage
          repository links. The server must also have <code className="text-accent">SESSION_SECRET</code>{' '}
          set in the environment (32+ characters).
        </p>
      </div>
      <form onSubmit={handleSubmit} className="relative space-y-4">
        <label className="block text-sm">
          <span className="text-text-muted">Client ID</span>
          <input
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border-default bg-void px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">Client secret</span>
          <input
            required
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border-default bg-void px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">Callback URL</span>
          <input
            required
            value={callbackUrl}
            onChange={(e) => setCallbackUrl(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border-default bg-void px-3 py-2 font-mono text-xs"
          />
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">Your GitHub login (app owner)</span>
          <input
            required
            value={ownerLogin}
            onChange={(e) => setOwnerLogin(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border-default bg-void px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">Additional admin logins (comma-separated)</span>
          <input
            value={adminLogins}
            onChange={(e) => setAdminLogins(e.target.value)}
            placeholder="optional"
            className="mt-1 w-full rounded-lg border border-border-default bg-void px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">Setup token (if NEXUS_SETUP_TOKEN is set on server)</span>
          <input
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            type="password"
            className="mt-1 w-full rounded-lg border border-border-default bg-void px-3 py-2 text-sm"
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          className="w-full cursor-pointer rounded-lg bg-accent py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save configuration'}
        </button>
      </form>
    </div>
  );
}
