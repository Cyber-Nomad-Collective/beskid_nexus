import { useCallback, useEffect, useMemo, useState } from 'react';
import { Github, Loader2, Sparkles, Trash2 } from '@/lib/lucide-icons';

import { Button } from '#/components/ui/button';
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '#/components/ui/sheet';
import {
	analyzeCatalogEntry,
	createCatalogEntry,
	deleteCatalogEntry,
	githubLoginUrl,
	type AuthUser,
	type PublicCatalogEntry,
} from '../services/nexus-api';

export interface RepoAdminSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	authUser: AuthUser | null;
	catalog: PublicCatalogEntry[];
	onCatalogChanged?: () => void;
}

export function RepoAdminSheet({
	open,
	onOpenChange,
	authUser,
	catalog,
	onCatalogChanged,
}: RepoAdminSheetProps) {
	const [error, setError] = useState<string | null>(null);
	const [displayName, setDisplayName] = useState('');
	const [description, setDescription] = useState('');
	const [gitUrl, setGitUrl] = useState('');
	const [analyzingId, setAnalyzingId] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const ownedEntries = useMemo(() => {
		const ownedIds = new Set(authUser?.ownedRepoIds ?? []);
		return catalog.filter((entry) => ownedIds.has(entry.id));
	}, [authUser?.ownedRepoIds, catalog]);

	const resetForm = useCallback(() => {
		setDisplayName('');
		setDescription('');
		setGitUrl('');
	}, []);

	useEffect(() => {
		if (!open) {
			setError(null);
			resetForm();
		}
	}, [open, resetForm]);

	const handleAdd = async (event: React.FormEvent) => {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			const entry = await createCatalogEntry({ displayName, description, gitUrl });
			resetForm();
			setAnalyzingId(entry.id);
			await analyzeCatalogEntry(entry.id);
			onCatalogChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to add repository');
		} finally {
			setAnalyzingId(null);
			setSubmitting(false);
		}
	};

	const handleAnalyze = async (id: string) => {
		setAnalyzingId(id);
		setError(null);
		try {
			await analyzeCatalogEntry(id, { force: true });
			onCatalogChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Re-index failed');
		} finally {
			setAnalyzingId(null);
		}
	};

	const handleDelete = async (id: string, name: string) => {
		if (!confirm(`Remove "${name}" from the catalog?`)) return;
		setError(null);
		try {
			await deleteCatalogEntry(id);
			onCatalogChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Delete failed');
		}
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
				<SheetHeader>
					<SheetTitle>Manage repositories</SheetTitle>
					<SheetDescription>
						Register and re-index repositories you own on GitHub.
					</SheetDescription>
				</SheetHeader>

				{!authUser ? (
					<div className="mt-8 text-center">
						<Github className="mx-auto mb-4 h-10 w-10 text-primary" />
						<p className="text-sm text-muted-foreground">Sign in to manage your repositories.</p>
						<Button
							className="mt-6"
							type="button"
							onClick={() => {
								window.location.href = githubLoginUrl();
							}}
						>
							Sign in with GitHub
						</Button>
					</div>
				) : (
					<div className="mt-6 space-y-6">
						{error ? <p className="text-sm text-destructive">{error}</p> : null}

						<form onSubmit={(e) => void handleAdd(e)} className="space-y-3 rounded-xl border border-border p-4">
							<h2 className="text-sm font-medium">Add repository</h2>
							<input
								required
								placeholder="Display name"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
							/>
							<textarea
								placeholder="Description"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								rows={2}
								className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
							/>
							<input
								required
								placeholder="https://github.com/org/repo"
								value={gitUrl}
								onChange={(e) => setGitUrl(e.target.value)}
								className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs"
							/>
							<Button type="submit" className="w-full" disabled={submitting}>
								<Sparkles className="mr-2 h-4 w-4" />
								{submitting ? 'Adding…' : 'Add and index'}
							</Button>
						</form>

						{ownedEntries.length > 0 ? (
							<ul className="space-y-2">
								{ownedEntries.map((entry) => (
									<li
										key={entry.id}
										className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted p-3"
									>
										<div className="min-w-0">
											<p className="font-medium">{entry.displayName}</p>
											<p className="truncate font-mono text-[10px] text-muted-foreground">
												{entry.gitUrl}
											</p>
											<p className="text-[10px] text-muted-foreground">
												{entry.indexed ? 'Indexed' : 'Pending index'}
											</p>
										</div>
										<div className="flex shrink-0 gap-2">
											<Button
												type="button"
												variant="outline"
												size="sm"
												disabled={analyzingId === entry.id}
												onClick={() => void handleAnalyze(entry.id)}
											>
												{analyzingId === entry.id ? '…' : 'Re-index'}
											</Button>
											<Button
												type="button"
												variant="outline"
												size="icon"
												className="text-destructive"
												aria-label={`Delete ${entry.displayName}`}
												onClick={() => void handleDelete(entry.id, entry.displayName)}
											>
												<Trash2 className="h-4 w-4" />
											</Button>
										</div>
									</li>
								))}
							</ul>
						) : (
							<p className="text-sm text-muted-foreground">
								No registered repositories yet. Add a GitHub repository you own above.
							</p>
						)}

						{analyzingId ? (
							<div className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 className="h-4 w-4 animate-spin" />
								Indexing in progress…
							</div>
						) : null}
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}
