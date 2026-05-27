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

export interface ResolvedNexusAdminConfig {
  adminLogins: string[];
  ownerLogin: string | null;
}

export const resolveNexusAdminConfig = async (): Promise<ResolvedNexusAdminConfig> => {
  const file = await loadNexusConfigFile();

  const envAdmins = (process.env.NEXUS_ADMIN_GITHUB_LOGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const fileAdmins = (file?.adminLogins || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const adminLogins = [...new Set([...envAdmins, ...fileAdmins])];

  const ownerLogin = file?.ownerLogin?.trim().toLowerCase() || null;

  return { adminLogins, ownerLogin };
};

/** @deprecated use resolveNexusAdminConfig */
export const resolveOAuthConfig = resolveNexusAdminConfig;

export const isAuthHubConfigured = async (): Promise<boolean> => {
  const file = await loadNexusConfigFile();
  const hubUrl =
    process.env.AUTH_HUB_PUBLIC_URL?.trim() || file?.authHubUrl?.trim() || '';
  const serviceToken =
    file?.authHubServiceToken?.trim() ||
    file?.authHubHandoffSecret?.trim() ||
    process.env.AUTH_HUB_SECRET?.trim() ||
    '';
  return !!(hubUrl && serviceToken.length >= 32);
};

export const isAdminRosterConfigured = async (): Promise<boolean> => {
  const cfg = await resolveNexusAdminConfig();
  return cfg.adminLogins.length > 0 || !!cfg.ownerLogin;
};

/** Nexus is ready for sign-in when the auth hub is paired and at least one admin login is set. */
export const isOAuthConfigured = async (): Promise<boolean> => {
  return (await isAuthHubConfigured()) && (await isAdminRosterConfigured());
};

export const isNexusAdmin = async (login: string): Promise<boolean> => {
  const cfg = await resolveNexusAdminConfig();
  const normalized = login.trim().toLowerCase();
  if (cfg.ownerLogin && cfg.ownerLogin === normalized) return true;
  return cfg.adminLogins.includes(normalized);
};
