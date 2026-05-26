import { useCallback, useEffect, useState } from 'react';
import { Github, Loader2, Sparkles, Trash2 } from '@/lib/lucide-icons';
import {
  analyzeCatalogEntry,
  createCatalogEntry,
  deleteCatalogEntry,
  fetchAdminCatalog,
  githubLoginUrl,
  type CatalogEntry,
} from '../services/nexus-api';
import { fetchAuthMe, type AuthUser } from '../services/nexus-api';

interface AdminCatalogPanelProps {
  onBack: () => void;
}

export function AdminCatalogPanel({ onBack }: AdminCatalogPanelProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await fetchAuthMe();
      setUser(me);
      const list = await fetchAdminCatalog();
      setEntries(list);
    } catch (err) {
      setUser(null);
      setError(err instanceof Error ? err.message : 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const entry = await createCatalogEntry({ displayName, description, gitUrl });
      setEntries((prev) => [...prev, entry]);
      setDisplayName('');
      setDescription('');
      setGitUrl('');
      setAnalyzingId(entry.id);
      await analyzeCatalogEntry(entry.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add entry');
    } finally {
      setAnalyzingId(null);
      void load();
    }
  };

  const handleAnalyze = async (id: string) => {
    setAnalyzingId(id);
    try {
      await analyzeCatalogEntry(id, { force: true });
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analyze failed');
    } finally {
      setAnalyzingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Remove "${id}" from the catalog?`)) return;
    try {
      await deleteCatalogEntry(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  if (!user?.isAdmin) {
    return (
      <div className="mx-auto max-w-md rounded-3xl border border-border-default bg-surface p-7 text-center">
        <Github className="mx-auto mb-4 h-10 w-10 text-accent" />
        <h2 className="text-lg font-semibold text-text-primary">Admin sign-in required</h2>
        <p className="mt-2 text-sm text-text-secondary">
          Sign in with a GitHub account that owns or administers the OAuth app.
        </p>
        <a
          href={githubLoginUrl()}
          className="mt-6 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          Sign in with GitHub
        </a>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 block w-full text-xs text-text-muted"
        >
          Back to catalog
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-text-primary">Catalog admin</h1>
        <button type="button" onClick={onBack} className="text-sm text-text-muted">
          Back
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <form onSubmit={handleAdd} className="space-y-3 rounded-xl border border-border-default bg-surface p-4">
        <h2 className="text-sm font-medium text-text-primary">Add repository</h2>
        <input
          required
          placeholder="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded-lg border border-border-default bg-void px-3 py-2 text-sm"
        />
        <textarea
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-border-default bg-void px-3 py-2 text-sm"
        />
        <input
          required
          placeholder="https://github.com/org/repo"
          value={gitUrl}
          onChange={(e) => setGitUrl(e.target.value)}
          className="w-full rounded-lg border border-border-default bg-void px-3 py-2 font-mono text-xs"
        />
        <button
          type="submit"
          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent py-2 text-sm text-white"
        >
          <Sparkles className="h-4 w-4" /> Add and index
        </button>
      </form>

      <ul className="space-y-2">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-border-default bg-elevated p-3"
          >
            <div className="min-w-0">
              <p className="font-medium text-text-primary">{entry.displayName}</p>
              <p className="truncate font-mono text-[10px] text-text-muted">{entry.gitUrl}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                disabled={analyzingId === entry.id}
                onClick={() => void handleAnalyze(entry.id)}
                className="cursor-pointer rounded-md border border-border-default px-2 py-1 text-xs"
              >
                {analyzingId === entry.id ? '…' : 'Re-index'}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(entry.id)}
                className="cursor-pointer rounded-md border border-red-500/30 p-1 text-red-400"
                aria-label="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
