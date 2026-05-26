import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminCatalogPanel } from './components/AdminCatalogPanel';
import { BeskidShellHeader } from './components/BeskidShellHeader';
import { CatalogHome } from './components/CatalogHome';
import { CodeReferencesPanel } from './components/CodeReferencesPanel';
import { DropZone } from './components/DropZone';
import { FileTreePanel } from './components/FileTreePanel';
import { GraphCanvas, type GraphCanvasHandle } from './components/GraphCanvas';
import { LoadingOverlay } from './components/LoadingOverlay';
import { OAuthSetupWizard } from './components/OAuthSetupWizard';
import { OnboardingGuide } from './components/OnboardingGuide';
import { RightPanel } from './components/RightPanel';
import { StatusBar } from './components/StatusBar';
import { BESKID_NEXUS } from './config/beskid-nexus';
import { ERROR_RESET_DELAY_MS } from './config/ui-constants';
import { createKnowledgeGraph } from './core/graph/graph';
import { useAppState } from './hooks/useAppState';
import { AppStateProvider } from './hooks/useAppState';
import {
	connectToServer,
	connectHeartbeat,
	fetchRepos,
	normalizeServerUrl,
	type ConnectResult,
} from './services/backend-client';
import { probeBackend } from './services/backend-client';
import {
	fetchAuthMe,
	fetchPublicCatalog,
	fetchSetupStatus,
	type PublicCatalogEntry,
} from './services/nexus-api';
import type { PipelineProgress } from 'gitnexus-shared';

type ShellPhase = 'boot' | 'setup' | 'server-down' | 'home' | 'admin' | 'advanced' | 'loading-graph';

const AppContent = () => {
	const [shellPhase, setShellPhase] = useState<ShellPhase>('boot');
	const [catalog, setCatalog] = useState<PublicCatalogEntry[]>([]);
	const [isAdmin, setIsAdmin] = useState(false);
	const bootstrapped = useRef(false);

	const {
		viewMode,
		progress,
		setViewMode,
		setGraph,
		setProgress,
		setProjectName,
		setCurrentRepo,
		setServerBaseUrl,
		setAvailableRepos,
		isRightPanelOpen,
		codeReferences,
		selectedNode,
		isCodePanelOpen,
	} = useAppState();

	const graphCanvasRef = useRef<GraphCanvasHandle>(null);
	const [serverDisconnected, setServerDisconnected] = useState(false);

	const applyConnectResult = useCallback(
		async (result: ConnectResult, serverUrl: string) => {
			const repoName = result.repoInfo.name;
			const repoPath = result.repoInfo.repoPath ?? result.repoInfo.path;
			const projectName =
				repoName ||
				(repoPath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
				BESKID_NEXUS.defaultRepo;

			setProjectName(projectName);
			setCurrentRepo(projectName);

			const graph = createKnowledgeGraph();
			for (const node of result.nodes) graph.addNode(node);
			for (const rel of result.relationships) graph.addRelationship(rel);
			setGraph(graph);

			const url = new URL(window.location.href);
			url.searchParams.set('project', projectName);
			window.history.replaceState(null, '', url.toString());
			setServerBaseUrl(normalizeServerUrl(serverUrl));
			setViewMode('exploring');
			setShellPhase('loading-graph');
			setProgress(null);
			fetchRepos()
				.then(setAvailableRepos)
				.catch((err) => console.warn('Failed to fetch repo list:', err));
		},
		[
			setAvailableRepos,
			setCurrentRepo,
			setGraph,
			setProgress,
			setProjectName,
			setServerBaseUrl,
			setViewMode,
		],
	);

	const connectProject = useCallback(
		(project: string, serverUrl = window.location.origin) => {
			setShellPhase('loading-graph');
			setViewMode('loading');
			setProgress({
				phase: 'extracting',
				percent: 0,
				message: 'Connecting to server…',
				detail: project,
			});

			connectToServer(
				serverUrl,
				(phase, downloaded, total) => {
					if (phase === 'validating') {
						setProgress({
							phase: 'extracting',
							percent: 5,
							message: 'Connecting to server…',
							detail: 'Validating backend',
						});
					} else if (phase === 'downloading') {
						const pct = total ? Math.round((downloaded! / total) * 90) + 5 : 50;
						setProgress({
							phase: 'extracting',
							percent: pct,
							message: 'Loading graph…',
							detail: `${((downloaded ?? 0) / (1024 * 1024)).toFixed(1)} MB`,
						});
					}
				},
				undefined,
				project,
				{ awaitAnalysis: true },
			)
				.then((result) => applyConnectResult(result, serverUrl))
				.catch((err) => {
					console.error('Connect failed:', err);
					setProgress({
						phase: 'error',
						percent: 0,
						message: 'Failed to connect',
						detail: err instanceof Error ? err.message : 'Unknown error',
					});
					setTimeout(() => {
						setViewMode('loading');
						setProgress(null);
						setShellPhase('home');
					}, ERROR_RESET_DELAY_MS);
				});
		},
		[applyConnectResult, setProgress, setViewMode],
	);

	const refreshHome = useCallback(async () => {
		const [entries, me] = await Promise.all([
			fetchPublicCatalog().catch(() => [] as PublicCatalogEntry[]),
			fetchAuthMe().catch(() => null),
		]);
		setCatalog(entries);
		setIsAdmin(!!me?.isAdmin);
	}, []);

	const runBoot = useCallback(async () => {
		const params = new URLSearchParams(window.location.search);
		const projectParam = params.get('project') || BESKID_NEXUS.defaultRepo || '';

		const serverUp = await probeBackend().catch(() => false);
		if (!serverUp) {
			setShellPhase('server-down');
			return;
		}

		const setup = await fetchSetupStatus().catch(() => ({
			oauthConfigured: true,
			oauthSource: 'none' as const,
			hasSessionSecret: false,
			hasSetupToken: false,
		}));

		if (!setup.oauthConfigured) {
			setShellPhase('setup');
			return;
		}

		const entries = await fetchPublicCatalog().catch(() => [] as PublicCatalogEntry[]);
		const me = await fetchAuthMe().catch(() => null);
		setCatalog(entries);
		setIsAdmin(!!me?.isAdmin);

		if (projectParam) {
			const match = entries.find(
				(e) => e.id === projectParam || e.registryName === projectParam,
			);
			const project = match?.registryName ?? match?.id ?? projectParam;
			connectProject(project);
			return;
		}

		setShellPhase('home');
	}, [connectProject]);

	useEffect(() => {
		if (bootstrapped.current) return;
		bootstrapped.current = true;
		void runBoot();
	}, [runBoot]);

	useEffect(() => {
		if (viewMode !== 'exploring') return;
		return connectHeartbeat(
			() => setServerDisconnected(false),
			() => setServerDisconnected(true),
		);
	}, [viewMode]);

	const handleFocusNode = useCallback((nodeId: string) => {
		graphCanvasRef.current?.focusNode(nodeId);
	}, []);

	const handleDropZoneConnect = useCallback(
		async (result: ConnectResult, serverUrl?: string) => {
			await applyConnectResult(result, serverUrl ?? window.location.origin);
		},
		[applyConnectResult],
	);

	if (shellPhase === 'boot') {
		return (
			<div className="flex min-h-screen items-center justify-center bg-void">
				<LoadingOverlay
					progress={
						{
							phase: 'extracting',
							percent: 0,
							message: 'Starting Beskid Nexus…',
						} as PipelineProgress
					}
				/>
			</div>
		);
	}

	if (shellPhase === 'setup') {
		return (
			<div className="flex min-h-screen items-center justify-center bg-void p-4">
				<OAuthSetupWizard
					onComplete={() => {
						bootstrapped.current = false;
						void runBoot();
					}}
				/>
			</div>
		);
	}

	if (shellPhase === 'server-down') {
		return (
			<div className="flex min-h-screen items-center justify-center bg-void p-4">
				<OnboardingGuide />
			</div>
		);
	}

	if (shellPhase === 'admin') {
		return (
			<div className="min-h-screen bg-void">
				<AdminCatalogPanel
					onBack={() => {
						void refreshHome().then(() => setShellPhase('home'));
					}}
				/>
			</div>
		);
	}

	if (shellPhase === 'advanced') {
		return (
			<div className="flex min-h-screen items-center justify-center bg-void p-4">
				<DropZone onServerConnect={handleDropZoneConnect} />
				<button
					type="button"
					className="fixed top-4 right-4 text-sm text-text-muted"
					onClick={() => setShellPhase('home')}
				>
				 Back to catalog
				</button>
			</div>
		);
	}

	if (shellPhase === 'home') {
		return (
			<div className="flex min-h-screen items-center justify-center bg-void p-4">
				<CatalogHome
					entries={catalog}
					isAdmin={isAdmin}
					onSelect={(entry) => {
						if (!entry.indexed) return;
						const project = entry.registryName ?? entry.id;
						connectProject(project);
					}}
					onAdmin={() => setShellPhase('admin')}
					onAdvanced={() => setShellPhase('advanced')}
				/>
			</div>
		);
	}

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
