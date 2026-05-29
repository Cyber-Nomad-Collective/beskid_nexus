import { Brain, Loader2, Check, AlertCircle, Zap } from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import { useState } from 'react';
import { WebGPUFallbackDialog } from './WebGPUFallbackDialog';

/**
 * Embedding status indicator and trigger button
 * Shows in header when graph is loaded
 */
export const EmbeddingStatus = () => {
  const { embeddingStatus, embeddingProgress, startEmbeddings, graph, viewMode, serverBaseUrl } =
    useAppState();

  const [showFallbackDialog, setShowFallbackDialog] = useState(false);

  // Only show when exploring a loaded graph; hide in backend mode (no WASM DB)
  if (viewMode !== 'exploring' || !graph || serverBaseUrl) return null;

  const nodeCount = graph.nodes.length;

  const handleStartEmbeddings = async (_forceDevice?: 'webgpu' | 'wasm') => {
    try {
      await startEmbeddings();
    } catch (error: any) {
      // Check if it's a WebGPU not available error
      if (
        error?.name === 'WebGPUNotAvailableError' ||
        error?.message?.includes('WebGPU not available')
      ) {
        setShowFallbackDialog(true);
      } else {
        console.error('Embedding failed:', error);
      }
    }
  };

  const handleUseCPU = () => {
    setShowFallbackDialog(false);
    handleStartEmbeddings('wasm');
  };

  const handleSkipEmbeddings = () => {
    setShowFallbackDialog(false);
    // Just close - user can try again later if they want
  };

  // WebGPU fallback dialog - rendered independently of state
  const fallbackDialog = (
    <WebGPUFallbackDialog
      isOpen={showFallbackDialog}
      onClose={() => setShowFallbackDialog(false)}
      onUseCPU={handleUseCPU}
      onSkip={handleSkipEmbeddings}
      nodeCount={nodeCount}
    />
  );

  // Idle state - show button to start
  if (embeddingStatus === 'idle') {
    return (
      <>
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleStartEmbeddings()}
            className="group flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground transition-all hover:border-primary/50 hover:bg-muted hover:text-foreground"
            title="Generate embeddings for semantic search"
          >
            <Brain className="h-4 w-4 text-node-interface transition-colors group-hover:text-primary" />
            <span className="hidden sm:inline">Enable Semantic Search</span>
            <Zap className="h-3 w-3 text-muted-foreground" />
          </button>
        </div>
        {fallbackDialog}
      </>
    );
  }

  // Loading model
  if (embeddingStatus === 'loading') {
    const downloadPercent = embeddingProgress?.percent ?? 0;
    return (
      <>
        <div className="flex items-center gap-2.5 rounded-lg border border-primary/30 bg-card px-3 py-1.5 text-sm">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Loading AI model...</span>
            <div className="h-1 w-24 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary to-node-interface transition-all duration-300"
                style={{ width: `${downloadPercent}%` }}
              />
            </div>
          </div>
        </div>
        {fallbackDialog}
      </>
    );
  }

  // Embedding in progress
  if (embeddingStatus === 'embedding') {
    const processed = 0;
    const total = 0;
    const percent = embeddingProgress?.percent ?? 0;

    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-node-function/30 bg-card px-3 py-1.5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-node-function" />
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">
            Embedding {processed}/{total} nodes
          </span>
          <div className="h-1 w-24 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-gradient-to-r from-node-function to-primary transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  // Indexing
  if (embeddingStatus === 'indexing') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-node-interface/30 bg-card px-3 py-1.5 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-node-interface" />
        <span className="text-xs">Creating vector index...</span>
      </div>
    );
  }

  // Ready
  if (embeddingStatus === 'ready') {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-node-function/30 bg-node-function/10 px-3 py-1.5 text-sm text-node-function"
        title="Semantic search is ready! Use natural language in the AI chat."
      >
        <Check className="h-4 w-4" />
        <span className="text-xs font-medium">Semantic Ready</span>
      </div>
    );
  }

  // Error
  if (embeddingStatus === 'error') {
    return (
      <>
        <button
          onClick={() => handleStartEmbeddings()}
          className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/20"
          title="Embedding failed. Click to retry."
        >
          <AlertCircle className="h-4 w-4" />
          <span className="text-xs">Failed - Retry</span>
        </button>
        {fallbackDialog}
      </>
    );
  }

  return null;
};
