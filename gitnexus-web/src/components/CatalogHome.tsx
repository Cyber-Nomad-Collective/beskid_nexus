import { useEffect, useMemo } from 'react';
import { ArrowRight, GitBranch, Layers, Loader2, RefreshCw, Sparkles } from '@/lib/lucide-icons';
import { ThemeToggle } from './theme-toggle';
import type { BackendRepo } from '../services/backend-client';
import {
  enrichCatalogEntry,
  indexedReposOutsideCatalog,
} from '../lib/catalog-match';
import type { PublicCatalogEntry } from '../services/nexus-api';

interface CatalogHomeProps {
  entries: PublicCatalogEntry[];
  indexedRepos?: BackendRepo[];
  onSelect: (entry: PublicCatalogEntry) => void;
  onSelectRepo?: (repoName: string) => void;
  onRefresh?: () => void | Promise<void>;
  onAdmin?: () => void;
  onAdvanced?: () => void;
  isAdmin?: boolean;
  isRefreshing?: boolean;
}

function CatalogCard({
  entry,
  onClick,
}: {
  entry: PublicCatalogEntry;
  onClick: () => void;
}) {
  const ready = entry.indexed;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!ready}
      className="nexus-card group w-full cursor-pointer p-4 text-left transition-all duration-200 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 shrink-0 text-primary" />
            <h3 className="truncate text-sm font-semibold text-foreground group-hover:text-primary">
              {entry.displayName}
            </h3>
          </div>
          {entry.description && (
            <p className="mt-2 pl-6 text-xs leading-relaxed text-muted-foreground">{entry.description}</p>
          )}
          <p className="mt-2 pl-6 font-mono text-[10px] text-muted-foreground">{entry.gitUrl}</p>
        </div>
        {ready ? (
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Indexing…
          </span>
        )}
      </div>
      {entry.stats?.nodes != null && (
        <div className="mt-3 flex flex-wrap gap-2 pl-6">
          <span className="inline-flex items-center gap-1 rounded-md bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
            <Layers className="h-3 w-3" /> {entry.stats.nodes.toLocaleString()} symbols
          </span>
        </div>
      )}
    </button>
  );
}

function IndexedRepoCard({
  repo,
  onClick,
}: {
  repo: BackendRepo;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="nexus-card group w-full cursor-pointer p-4 text-left transition-all duration-200 hover:bg-muted"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 shrink-0 text-primary" />
            <h3 className="truncate text-sm font-semibold text-foreground group-hover:text-primary">
              {repo.name}
            </h3>
          </div>
          {repo.indexedAt && (
            <p className="mt-1 pl-6 text-xs text-muted-foreground">
              Indexed {new Date(repo.indexedAt).toLocaleString()}
            </p>
          )}
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
      </div>
      {repo.stats?.nodes != null && (
        <div className="mt-3 flex flex-wrap gap-2 pl-6">
          <span className="inline-flex items-center gap-1 rounded-md bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
            <Layers className="h-3 w-3" /> {repo.stats.nodes.toLocaleString()} symbols
          </span>
        </div>
      )}
    </button>
  );
}

export function CatalogHome({
  entries,
  indexedRepos = [],
  onSelect,
  onSelectRepo,
  onRefresh,
  onAdmin,
  onAdvanced,
  isAdmin,
  isRefreshing = false,
}: CatalogHomeProps) {
  const enrichedEntries = useMemo(
    () => entries.map((entry) => enrichCatalogEntry(entry, indexedRepos)),
    [entries, indexedRepos],
  );
  const extraRepos = useMemo(
    () => indexedReposOutsideCatalog(enrichedEntries, indexedRepos),
    [enrichedEntries, indexedRepos],
  );
  const hasPendingIndex = enrichedEntries.some((e) => !e.indexed);
  const hasSelectable =
    enrichedEntries.some((e) => e.indexed) || extraRepos.length > 0;

  useEffect(() => {
    if (!hasPendingIndex || !onRefresh) return;
    const timer = window.setInterval(() => {
      void onRefresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [hasPendingIndex, onRefresh]);

  return (
    <div className="nexus-card relative mx-auto max-w-2xl animate-fade-in overflow-hidden p-7">
      <div className="pointer-events-none absolute -top-28 -right-28 h-72 w-72 rounded-full bg-primary/6 blur-3xl" />
      <div className="relative mb-6 text-center">
        <p className="nexus-kicker mb-2">Beskid Nexus</p>
        <Sparkles className="mx-auto mb-2 h-6 w-6 text-primary/80" />
        <h1 className="text-xl font-semibold text-foreground">Repository catalog</h1>
        <p className="mt-1 text-sm text-muted-foreground">Choose a repository knowledge graph</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <ThemeToggle />
          {onRefresh && (
            <button
              type="button"
              onClick={() => void onRefresh()}
              disabled={isRefreshing}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          )}
          {isAdmin && onAdmin && (
            <button
              type="button"
              onClick={onAdmin}
              className="cursor-pointer rounded-lg border border-primary/40 px-3 py-1.5 text-xs text-primary"
            >
              Manage catalog
            </button>
          )}
          {onAdvanced && (
            <button
              type="button"
              onClick={onAdvanced}
              className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground"
            >
              Analyze new repo
            </button>
          )}
        </div>
      </div>

      {enrichedEntries.length > 0 && (
        <div className="relative space-y-3">
          {enrichedEntries.length > 1 || extraRepos.length > 0 ? (
            <p className="nexus-kicker">Catalog</p>
          ) : null}
          {enrichedEntries.map((entry) => (
            <CatalogCard
              key={entry.id}
              entry={entry}
              onClick={() => onSelect(entry)}
            />
          ))}
        </div>
      )}

      {extraRepos.length > 0 && (
        <div className={`relative space-y-3 ${enrichedEntries.length > 0 ? 'mt-6' : ''}`}>
          <p className="nexus-kicker">
            {enrichedEntries.length > 0 ? 'Other indexed repositories' : 'Indexed repositories'}
          </p>
          {extraRepos.map((repo) => (
            <IndexedRepoCard
              key={repo.name}
              repo={repo}
              onClick={() => onSelectRepo?.(repo.name)}
            />
          ))}
        </div>
      )}

      {enrichedEntries.length === 0 && extraRepos.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">
          No indexed repositories yet.
          {isAdmin ? ' Add one in Manage catalog or analyze a new repo.' : ' Ask an admin to add catalog entries.'}
        </p>
      )}

      {hasPendingIndex && !hasSelectable && (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Repositories are indexing in the background. This page refreshes automatically.
        </p>
      )}
    </div>
  );
}
