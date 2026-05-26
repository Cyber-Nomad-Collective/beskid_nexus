import type { ResolvedOAuthConfig } from './nexus-config.js';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export const buildGitHubAuthorizeUrl = (cfg: ResolvedOAuthConfig, state: string): string => {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.callbackUrl);
  url.searchParams.set('scope', 'read:user repo');
  url.searchParams.set('state', state);
  return url.toString();
};

export const exchangeGitHubCode = async (
  cfg: ResolvedOAuthConfig,
  code: string,
): Promise<string> => {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed (${response.status})`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? 'Missing access token');
  }

  return payload.access_token;
};

export const fetchGitHubUser = async (
  accessToken: string,
): Promise<{ login: string; avatar_url: string; name: string | null }> => {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'beskid-nexus',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user fetch failed (${response.status})`);
  }
  const data = (await response.json()) as {
    login: string;
    avatar_url: string;
    name: string | null;
  };
  return data;
};
