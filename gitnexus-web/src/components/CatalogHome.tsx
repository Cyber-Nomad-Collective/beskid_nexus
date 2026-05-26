import { ArrowRight, GitBranch, Layers, Sparkles } from '@/lib/lucide-icons';
import type { PublicCatalogEntry } from '../services/nexus-api';

interface CatalogHomeProps {
  entries: PublicCatalogEntry[];
  onSelect: (entry: PublicCatalogEntry) => void;
  onAdmin?: () => void;
  onAdvanced?: () => void;
  isAdmin?: boolean;
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
      className="group w-full cursor-pointer rounded-xl border border-border-default bg-elevated p-4 text-left transition-all duration-200 hover:border-accent/40 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 shrink-0 text-accent" />
            <h3 className="truncate text-sm font-semibold text-text-primary group-hover:text-accent">
              {entry.displayName}
            </h3>
          </div>
          {entry.description && (
            <p className="mt-2 pl-6 text-xs leading-relaxed text-text-secondary">{entry.description}</p>
          )}
          <p className="mt-2 pl-6 font-mono text-[10px] text-text-muted">{entry.gitUrl}</p>
        </div>
        {ready ? (
          <ArrowRight className="h-4 w-4 shrink-0 text-text-muted opacity-0 transition group-hover:opacity-100" />
        ) : (
          <span className="shrink-0 rounded-md bg-void px-2 py-0.5 text-[10px] text-text-muted">
            Not indexed
          </span>
        )}
      </div>
      {entry.stats?.nodes != null && (
        <div className="mt-3 flex flex-wrap gap-2 pl-6">
          <span className="inline-flex items-center gap-1 rounded-md bg-void px-2 py-0.5 text-[11px] text-text-muted">
            <Layers className="h-3 w-3" /> {entry.stats.nodes.toLocaleString()} symbols
          </span>
        </div>
      )}
    </button>
  );
}

export function CatalogHome({ entries, onSelect, onAdmin, onAdvanced, isAdmin }: CatalogHomeProps) {
  return (
    <div className="relative mx-auto max-w-2xl animate-fade-in overflow-hidden rounded-3xl border border-border-default bg-surface p-7">
      <div className="pointer-events-none absolute -top-28 -right-28 h-72 w-72 rounded-full bg-accent/6 blur-3xl" />
      <div className="relative mb-6 text-center">
        <Sparkles className="mx-auto mb-2 h-6 w-6 text-accent/80" />
        <h1 className="text-xl font-semibold text-text-primary">Beskid Nexus</h1>
        <p className="mt-1 text-sm text-text-secondary">Choose a repository knowledge graph</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {isAdmin && onAdmin && (
            <button
              type="button"
              onClick={onAdmin}
              className="cursor-pointer rounded-lg border border-accent/40 px-3 py-1.5 text-xs text-accent"
            >
              Manage catalog
            </button>
          )}
          {onAdvanced && (
            <button
              type="button"
              onClick={onAdvanced}
              className="cursor-pointer rounded-lg border border-border-default px-3 py-1.5 text-xs text-text-muted"
            >
              Advanced
            </button>
          )}
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="text-center text-sm text-text-muted">
          No repositories in the catalog yet.
          {isAdmin ? ' Open Manage catalog to add one.' : ''}
        </p>
      ) : (
        <div className="relative space-y-3">
          {entries.map((entry) => (
            <CatalogCard key={entry.id} entry={entry} onClick={() => onSelect(entry)} />
          ))}
        </div>
      )}
    </div>
  );
}
