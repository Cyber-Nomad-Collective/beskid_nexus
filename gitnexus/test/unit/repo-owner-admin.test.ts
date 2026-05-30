import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs/promises';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { Server } from 'http';
import { JobManager } from '../../src/server/analyze-job.js';
import { mountNexusRoutes } from '../../src/server/nexus/mount-nexus-routes.js';
import { sealSession } from '../../src/server/nexus/session.js';
import { isUserRepoOwner } from '../../src/server/nexus/github-ownership.js';

vi.mock('../../src/server/nexus/github-ownership.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/nexus/github-ownership.js')>();
  return {
    ...actual,
    isUserRepoOwner: vi.fn(),
  };
});

const mockedIsUserRepoOwner = vi.mocked(isUserRepoOwner);

describe('repo-owner admin catalog routes', () => {
  let tmpHome: string;
  let server: Server;
  let baseUrl: string;
  let savedSessionSecret: string | undefined;
  let savedGitnexusHome: string | undefined;
  const jobManager = new JobManager();

  const ownerSession = {
    login: 'octocat',
    name: 'Octocat',
    avatarUrl: 'https://avatars.example/octocat',
    hubUserToken: 'hub-token',
    hubSessionId: 'sess-1',
  };

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), 'nexus-ws2-'));
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    savedSessionSecret = process.env.SESSION_SECRET;
    process.env.GITNEXUS_HOME = tmpHome;
    process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars!!';

    const app = express();
    app.use(express.json());
    mountNexusRoutes(app, {
      backend: {} as any,
      jobManager,
      acquireRepoLock: () => null,
      releaseRepoLock: () => {},
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    jobManager.dispose();
    await rm(tmpHome, { recursive: true, force: true });
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    if (savedSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = savedSessionSecret;
    vi.clearAllMocks();
  });

  async function authCookie(login = ownerSession.login): Promise<string> {
    const token = await sealSession({ ...ownerSession, login });
    return `beskid_nexus_session=${encodeURIComponent(token)}`;
  }

  it('allows repo owner to POST catalog', async () => {
    mockedIsUserRepoOwner.mockResolvedValue(true);
    const res = await fetch(`${baseUrl}/api/admin/catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: await authCookie(),
      },
      body: JSON.stringify({
        displayName: 'Demo',
        gitUrl: 'https://github.com/octocat/demo',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.displayName).toBe('Demo');
    expect(mockedIsUserRepoOwner).toHaveBeenCalledWith(
      'octocat',
      'https://github.com/octocat/demo',
      expect.objectContaining({ hubUserToken: 'hub-token' }),
    );
  });

  it('returns 403 when non-owner POSTs catalog', async () => {
    mockedIsUserRepoOwner.mockResolvedValue(false);
    const res = await fetch(`${baseUrl}/api/admin/catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: await authCookie(),
      },
      body: JSON.stringify({
        displayName: 'Demo',
        gitUrl: 'https://github.com/other/demo',
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/owner/i);
  });

  it('returns ownedRepoIds on /api/auth/me', async () => {
    const now = '2026-05-30T00:00:00.000Z';
    await fs.writeFile(
      path.join(tmpHome, 'catalog.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'owned-repo',
            displayName: 'Owned',
            description: '',
            gitUrl: 'https://github.com/octocat/owned',
            enabled: true,
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'other-repo',
            displayName: 'Other',
            description: '',
            gitUrl: 'https://github.com/someone/other',
            enabled: true,
            sortOrder: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );
    mockedIsUserRepoOwner.mockImplementation(async (_login, gitUrl) =>
      gitUrl.includes('octocat/owned'),
    );

    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: await authCookie() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ownedRepoIds).toEqual(['owned-repo']);
  });
});
