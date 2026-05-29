import { GitBranch, PanelRightClose } from '@/lib/lucide-icons';

import { useAppState } from '../hooks/useAppState';
import { ProcessesPanel } from './ProcessesPanel';

/** Beskid Nexus: execution-flow panel only (no Graph RAG chat). */
export const RightPanel = () => {
	const { isRightPanelOpen, setRightPanelOpen } = useAppState();

	if (!isRightPanelOpen) return null;

	return (
		<aside className="relative z-30 flex w-[40%] max-w-[600px] min-w-[400px] flex-shrink-0 animate-slide-in flex-col border-l border-border bg-muted">
			<div className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
				<div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
					<GitBranch className="h-3.5 w-3.5" />
					<span>Execution flows</span>
				</div>
				<button
					type="button"
					onClick={() => setRightPanelOpen(false)}
					className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					title="Close panel"
				>
					<PanelRightClose className="h-4 w-4" />
				</button>
			</div>
			<div className="flex flex-1 flex-col overflow-hidden">
				<ProcessesPanel />
			</div>
		</aside>
	);
};
