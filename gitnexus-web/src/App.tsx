import { useCallback, useEffect, useRef, useState } from 'react';

import { BeskidShellHeader } from './components/BeskidShellHeader';
import { CodeReferencesPanel } from './components/CodeReferencesPanel';
import { FileTreePanel } from './components/FileTreePanel';
import { GraphCanvas, type GraphCanvasHandle } from './components/GraphCanvas';
import { LoadingOverlay } from './components/LoadingOverlay';
import { RightPanel } from './components/RightPanel';
import { StatusBar } from './components/StatusBar';
import { useAppState } from './hooks/useAppState';
import { AppStateProvider } from './hooks/useAppState';
import { useServerBootstrap } from './hooks/useServerBootstrap';
import { connectHeartbeat } from './services/backend-client';

const AppContent = () => {
	useServerBootstrap();

	const {
		viewMode,
		progress,
		isRightPanelOpen,
		codeReferences,
		selectedNode,
		isCodePanelOpen,
	} = useAppState();

	const graphCanvasRef = useRef<GraphCanvasHandle>(null);
	const [serverDisconnected, setServerDisconnected] = useState(false);

	const handleFocusNode = useCallback((nodeId: string) => {
		graphCanvasRef.current?.focusNode(nodeId);
	}, []);

	useEffect(() => {
		if (viewMode !== 'exploring') return;
		return connectHeartbeat(
			() => setServerDisconnected(false),
			() => setServerDisconnected(true),
		);
	}, [viewMode]);

	if (viewMode === 'loading' && progress) {
		return <LoadingOverlay progress={progress} />;
	}

	if (viewMode !== 'exploring') {
		return null;
	}

	return (
		<div className="flex h-screen flex-col overflow-hidden bg-void">
			<BeskidShellHeader onFocusNode={handleFocusNode} />

			<main className="flex min-h-0 flex-1">
				<FileTreePanel onFocusNode={handleFocusNode} />

				<div className="relative min-w-0 flex-1">
					<GraphCanvas ref={graphCanvasRef} />

					{isCodePanelOpen && (codeReferences.length > 0 || !!selectedNode) && (
						<div className="pointer-events-auto absolute inset-y-0 left-0 z-30">
							<CodeReferencesPanel onFocusNode={handleFocusNode} />
						</div>
					)}
				</div>

				{isRightPanelOpen && <RightPanel />}
			</main>

			<StatusBar />

			{serverDisconnected && (
				<div className="fixed bottom-12 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-yellow-500/30 bg-yellow-900/80 px-4 py-2 text-sm text-yellow-200 shadow-lg backdrop-blur">
					Server connection lost — reconnecting…
				</div>
			)}
		</div>
	);
};

export default function App() {
	return (
		<AppStateProvider>
			<AppContent />
		</AppStateProvider>
	);
}
