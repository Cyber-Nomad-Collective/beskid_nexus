export interface NexusCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  gitUrl: string;
  defaultBranch?: string;
  enabled: boolean;
  sortOrder: number;
  registryName?: string;
  lastIndexedCommit?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NexusCatalogFile {
  version: 1;
  entries: NexusCatalogEntry[];
}

export interface NexusConfigFile {
  ownerLogin: string;
  adminLogins: string[];
  authHubUrl?: string;
  /** @deprecated use authHubServiceToken */
  authHubHandoffSecret?: string;
  authHubServiceToken?: string;
}

export interface NexusSessionPayload {
  login: string;
  avatarUrl: string;
  name: string | null;
  hubUserToken: string;
  hubSessionId: string;
}

/** Repo-scoped AI code documentation — separate from platform spec body text. */
export interface CodeDocRecord {
  entityId: string;
  entityKind: 'node' | 'cluster';
  /** Describes what this code does in the repo. Must NOT contain platform-spec prose. */
  codeDoc: string;
  /** 0–3 canonical links into site/website platform-spec. href must exist in spec index. */
  specLinks: Array<{ title: string; href: string }>;
  contentHash: string;
  updatedAt: string;
}

export interface PublicCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  gitUrl: string;
  defaultBranch?: string;
  sortOrder: number;
  indexed: boolean;
  registryName?: string;
  lastIndexedCommit?: string;
  indexedAt?: string;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
  };
  docStatus?: 'idle' | 'running' | 'failed' | 'ready';
}
