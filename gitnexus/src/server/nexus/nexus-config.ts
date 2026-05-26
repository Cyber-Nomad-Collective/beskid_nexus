import fs from 'fs/promises';
import path from 'path';
import { getGlobalDir } from '../../storage/repo-manager.js';
import type { NexusConfigFile } from './types.js';

const CONFIG_FILE = 'nexus-config.json';

export const getNexusConfigPath = (): string => path.join(getGlobalDir(), CONFIG_FILE);

export const loadNexusConfigFile = async (): Promise<NexusConfigFile | null> => {
  try {
    const raw = await fs.readFile(getNexusConfigPath(), 'utf-8');
    return JSON.parse(raw) as NexusConfigFile;
  } catch {
    return null;
  }
};

export const saveNexusConfigFile = async (config: NexusConfigFile): Promise<void> => {
  const dir = getGlobalDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getNexusConfigPath(), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
};

export interface ResolvedOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  adminLogins: string[];
  ownerLogin: string | null;
  source: 'env' | 'file' | 'none';
}

export const resolveOAuthConfig = async (): Promise<ResolvedOAuthConfig> => {
  const file = await loadNexusConfigFile();

  const clientId = process.env.GITHUB_CLIENT_ID?.trim() || file?.githubClientId || '';
  const clientSecret =
    process.env.GITHUB_CLIENT_SECRET?.trim() || file?.githubClientSecret || '';
  const callbackUrl =
    process.env.GITHUB_OAUTH_CALLBACK_URL?.trim() || file?.githubOAuthCallbackUrl || '';

  const envAdmins = (process.env.NEXUS_ADMIN_GITHUB_LOGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const fileAdmins = (file?.adminLogins || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const adminLogins = [...new Set([...envAdmins, ...fileAdmins])];

  const ownerLogin = file?.ownerLogin?.trim().toLowerCase() || null;

  let source: ResolvedOAuthConfig['source'] = 'none';
  if (clientId && clientSecret && callbackUrl) {
    source = process.env.GITHUB_CLIENT_ID?.trim() ? 'env' : 'file';
  }

  return { clientId, clientSecret, callbackUrl, adminLogins, ownerLogin, source };
};

export const isOAuthConfigured = async (): Promise<boolean> => {
  const cfg = await resolveOAuthConfig();
  return !!(cfg.clientId && cfg.clientSecret && cfg.callbackUrl);
};

export const isNexusAdmin = async (login: string): Promise<boolean> => {
  const cfg = await resolveOAuthConfig();
  const normalized = login.trim().toLowerCase();
  if (cfg.ownerLogin && cfg.ownerLogin === normalized) return true;
  return cfg.adminLogins.includes(normalized);
};
