export function parseGitHubOwnerRepo(gitUrl: string): { owner: string; repo: string } | null {
  const normalized = gitUrl.trim().replace(/\.git$/i, '').replace(/\/$/, '');
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)/i);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

export async function isUserRepoOwner(
  login: string,
  gitUrl: string,
  opts: { hubUserToken: string; fetchImpl?: typeof fetch },
): Promise<boolean> {
  const parsed = parseGitHubOwnerRepo(gitUrl);
  if (!parsed) return false;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
    headers: {
      Authorization: `Bearer ${opts.hubUserToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'beskid-nexus',
    },
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { permissions?: { admin?: boolean }; owner?: { login?: string } };
  if (data.owner?.login?.toLowerCase() === login.toLowerCase()) return true;
  return !!data.permissions?.admin;
}
