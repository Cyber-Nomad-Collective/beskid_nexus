import { Search, Settings, HelpCircle } from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import { useMemo, useRef, useState, useEffect } from 'react';
import { GraphNode } from 'gitnexus-shared';

const NODE_TYPE_COLORS: Record<string, string> = {
	Folder: '#6366f1',
	File: '#3b82f6',
	Function: '#10b981',
	Class: '#f59e0b',
	Method: '#14b8a6',
	Interface: '#ec4899',
	Variable: '#64748b',
	Import: '#475569',
	Type: '#a78bfa',
};

interface BeskidShellHeaderProps {
	onFocusNode?: (nodeId: string) => void;
}

export const BeskidShellHeader = ({ onFocusNode }: BeskidShellHeaderProps) => {
	const { projectName, graph, setSettingsPanelOpen, setHelpDialogBoxOpen } = useAppState();
	const [searchQuery, setSearchQuery] = useState('');
	const [isSearchOpen, setIsSearchOpen] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const searchRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const nodeCount = graph?.nodes.length ?? 0;
	const edgeCount = graph?.relationships.length ?? 0;

	const searchResults = useMemo(() => {
		if (!graph || !searchQuery.trim()) return [];
		const q = searchQuery.toLowerCase();
		return graph.nodes
			.filter((n) => {
				const name = (n.properties.name as string) || '';
				const path = (n.properties.filePath as string) || '';
				return name.toLowerCase().includes(q) || path.toLowerCase().includes(q);
			})
			.slice(0, 12);
	}, [graph, searchQuery]);

	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (searchRef.current && e.target instanceof HTMLElement && !searchRef.current.contains(e.target)) {
				setIsSearchOpen(false);
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, []);

	const handleSelectNode = (node: GraphNode) => {
		onFocusNode?.(node.id);
		setSearchQuery('');
		setIsSearchOpen(false);
	};

	return (
		<header className="beskid-nexus-header">
			<div className="beskid-nexus-header__brand">
				<span className="beskid-nexus-header__kicker">Beskid</span>
				<span className="text-muted-foreground">/</span>
				<span className="beskid-nexus-header__title">Nexus</span>
				{projectName ? (
					<>
						<span className="text-muted-foreground">/</span>
						<span className="truncate text-sm text-muted-foreground">{projectName}</span>
					</>
				) : null}
			</div>

			<div className="beskid-nexus-header__actions">
				<span className="beskid-nexus-header__stats hidden sm:inline">
					{nodeCount.toLocaleString()} nodes · {edgeCount.toLocaleString()} edges
				</span>

				<div ref={searchRef} className="relative">
					<div className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1">
						<Search className="h-4 w-4 text-muted-foreground" />
						<input
							ref={inputRef}
							type="search"
							placeholder="Search symbols…"
							className="w-40 bg-transparent text-sm outline-none sm:w-56"
							value={searchQuery}
							onChange={(e) => {
								setSearchQuery(e.target.value);
								setIsSearchOpen(true);
								setSelectedIndex(0);
							}}
							onFocus={() => setIsSearchOpen(true)}
							onKeyDown={(e) => {
								if (!isSearchOpen || searchResults.length === 0) return;
								if (e.key === 'ArrowDown') {
									e.preventDefault();
									setSelectedIndex((i) => Math.min(i + 1, searchResults.length - 1));
								} else if (e.key === 'ArrowUp') {
									e.preventDefault();
									setSelectedIndex((i) => Math.max(i - 1, 0));
								} else if (e.key === 'Enter') {
									e.preventDefault();
									handleSelectNode(searchResults[selectedIndex]);
								} else if (e.key === 'Escape') {
									setIsSearchOpen(false);
								}
							}}
						/>
					</div>
					{isSearchOpen && searchResults.length > 0 && (
						<ul className="absolute right-0 z-50 mt-1 max-h-72 w-72 overflow-auto rounded-md border border-border bg-popover py-1 shadow-lg">
							{searchResults.map((node, idx) => (
								<li key={node.id}>
									<button
										type="button"
										className={`flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-accent ${
											idx === selectedIndex ? 'bg-accent' : ''
										}`}
										onClick={() => handleSelectNode(node)}
									>
										<span
											className="font-medium"
											style={{ color: NODE_TYPE_COLORS[node.label] ?? '#94a3b8' }}
										>
											{node.properties.name as string}
										</span>
										<span className="truncate text-xs text-muted-foreground">
											{node.properties.filePath as string}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>

				<button
					type="button"
					className="rounded-md p-2 hover:bg-accent"
					title="Help"
					onClick={() => setHelpDialogBoxOpen(true)}
				>
					<HelpCircle className="h-4 w-4" />
				</button>
				<button
					type="button"
					className="rounded-md p-2 hover:bg-accent"
					title="Settings"
					onClick={() => setSettingsPanelOpen(true)}
				>
					<Settings className="h-4 w-4" />
				</button>
				<beskid-hub />
			</div>
		</header>
	);
};

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace JSX {
		interface IntrinsicElements {
			'beskid-hub': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
		}
	}
}
