import { describe, it, expect, vi } from 'vitest';
import { parseGitHubOwnerRepo, isUserRepoOwner } from '../../src/server/nexus/github-ownership.js';

describe('parseGitHubOwnerRepo', () => {
  it('parses https github url', () => {
    expect(parseGitHubOwnerRepo('https://github.com/Cyber-Nomad-Collective/beskid')).toEqual({
      owner: 'Cyber-Nomad-Collective',
      repo: 'beskid',
    });
  });
});

describe('isUserRepoOwner', () => {
  it('returns true when API reports admin permission', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: { admin: true } }),
    });
    const result = await isUserRepoOwner('octocat', 'https://github.com/octocat/demo', {
      hubUserToken: 'tok',
      fetchImpl: fetchMock,
    });
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/octocat/demo',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
  });
});
