import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { LocalBackend } from '../../mcp/local/local-backend.js';
import type { JobManager } from '../analyze-job.js';
import { createRouteLimiter } from '../validation.js';
import {
  isOAuthConfigured,
  isNexusAdmin,
  resolveOAuthConfig,
  saveNexusConfigFile,
} from './nexus-config.js';
import {
  createCatalogEntry,
  deleteCatalogEntry,
  getCatalogEntry,
  listPublicCatalog,
  updateCatalogEntry,
  slugifyCatalogId,
  findCatalogByGitUrl,
  listCatalogEntries,
} from './catalog-store.js';
import {
  appendSetCookie,
  clearOAuthStateCookieHeader,
  clearSessionCookieHeader,
  getSessionFromRequest,
  oauthStateCookieHeader,
  readOAuthStateCookie,
  sealSession,
  sessionCookieHeader,
} from './session.js';
import {
  buildGitHubAuthorizeUrl,
  exchangeGitHubCode,
  fetchGitHubUser,
} from './github-oauth.js';
import { startAnalyzeJob, type AnalyzeRunnerDeps } from './analyze-runner.js';
import { getRemoteHead } from './remote-git.js';
import { logger } from '../../core/logger.js';

export interface MountNexusRoutesDeps extends AnalyzeRunnerDeps {
  backend: LocalBackend;
  jobManager: JobManager;
  acquireRepoLock: (repoPath: string) => string | null;
  releaseRepoLock: (repoPath: string) => void;
}

const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await getSessionFromRequest(req);
    if (!session) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!(await isNexusAdmin(session.login))) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    (req as any).nexusSession = session;
    next();
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Auth check failed' });
  }
};

const verifySetupToken = (req: Request): boolean => {
  const expected = process.env.NEXUS_SETUP_TOKEN?.trim();
  if (!expected) return false;
  const header = req.headers.authorization;
  if (header === `Bearer ${expected}`) return true;
  const bodyToken = typeof req.body?.setupToken === 'string' ? req.body.setupToken : '';
  return bodyToken === expected;
};

export const mountNexusRoutes = (app: Express, deps: MountNexusRoutesDeps): void => {
  const runnerDeps: AnalyzeRunnerDeps = {
    jobManager: deps.jobManager,
    backend: deps.backend,
    acquireRepoLock: deps.acquireRepoLock,
    releaseRepoLock: deps.releaseRepoLock,
  };

  // ── Setup ─────────────────────────────────────────────────────────────

  app.get('/api/admin/setup/status', async (_req, res) => {
    const configured = await isOAuthConfigured();
    const oauth = await resolveOAuthConfig();
    res.json({
      oauthConfigured: configured,
      oauthSource: oauth.source,
      hasSessionSecret: !!(process.env.SESSION_SECRET?.trim() && process.env.SESSION_SECRET.length >= 32),
      hasSetupToken: !!process.env.NEXUS_SETUP_TOKEN?.trim(),
    });
  });

  app.post('/api/admin/setup', createRouteLimiter({ limit: 5 }), async (req, res) => {
    try {
      const already = await isOAuthConfigured();
      const setupTokenRequired = !!process.env.NEXUS_SETUP_TOKEN?.trim();
      if (already && !verifySetupToken(req)) {
        res.status(403).json({ error: 'OAuth already configured' });
        return;
      }
      if (!already && setupTokenRequired && !verifySetupToken(req)) {
        res.status(403).json({ error: 'Invalid setup token' });
        return;
      }

      const {
        githubClientId,
        githubClientSecret,
        githubOAuthCallbackUrl,
        ownerLogin,
        adminLogins,
      } = req.body ?? {};

      if (
        typeof githubClientId !== 'string' ||
        typeof githubClientSecret !== 'string' ||
        typeof githubOAuthCallbackUrl !== 'string' ||
        typeof ownerLogin !== 'string'
      ) {
        res.status(400).json({ error: 'Missing OAuth app fields' });
        return;
      }

      const admins: string[] = Array.isArray(adminLogins)
        ? adminLogins.map((s: string) => String(s).trim().toLowerCase()).filter(Boolean)
        : String(adminLogins || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);

      const owner = ownerLogin.trim().toLowerCase();
      if (!admins.includes(owner)) admins.push(owner);

      await saveNexusConfigFile({
        githubClientId: githubClientId.trim(),
        githubClientSecret: githubClientSecret.trim(),
        githubOAuthCallbackUrl: githubOAuthCallbackUrl.trim(),
        ownerLogin: owner,
        adminLogins: admins,
      });

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Setup failed' });
    }
  });

  // ── Auth ──────────────────────────────────────────────────────────────

  app.get('/api/auth/github', async (_req, res) => {
    const cfg = await resolveOAuthConfig();
    if (!cfg.clientId || !cfg.callbackUrl) {
      res.status(503).json({ error: 'GitHub OAuth is not configured' });
      return;
    }
    const state = randomUUID();
    appendSetCookie(res, oauthStateCookieHeader(state));
    res.redirect(buildGitHubAuthorizeUrl(cfg, state));
  });

  app.get('/api/auth/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const stored = readOAuthStateCookie(req);
    appendSetCookie(res, clearOAuthStateCookieHeader());

    if (!code || !state || !stored || state !== stored) {
      res.redirect('/?error=oauth_state');
      return;
    }

    try {
      const cfg = await resolveOAuthConfig();
      const accessToken = await exchangeGitHubCode(cfg, code);
      const user = await fetchGitHubUser(accessToken);
      const token = await sealSession({
        accessToken,
        login: user.login,
        avatarUrl: user.avatar_url,
        name: user.name,
      });
      appendSetCookie(res, sessionCookieHeader(token));
      res.redirect('/?auth=ok');
    } catch (err) {
      logger.error({ err }, 'OAuth callback failed');
      appendSetCookie(res, clearSessionCookieHeader());
      res.redirect('/?error=oauth_failed');
    }
  });

  app.get('/api/auth/me', async (req, res) => {
    const session = await getSessionFromRequest(req);
    if (!session) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.json({
      login: session.login,
      name: session.name,
      avatarUrl: session.avatarUrl,
      isAdmin: await isNexusAdmin(session.login),
    });
  });

  app.post('/api/auth/logout', (_req, res) => {
    appendSetCookie(res, clearSessionCookieHeader());
    res.json({ ok: true });
  });

  // ── Public catalog ────────────────────────────────────────────────────

  app.get('/api/catalog', async (_req, res) => {
    try {
      const entries = await listPublicCatalog();
      res.json(entries);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list catalog' });
    }
  });

  app.get('/api/catalog/:id', async (req, res) => {
    try {
      const entry = await getCatalogEntry(req.params.id);
      if (!entry || !entry.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const [publicEntry] = (await listPublicCatalog()).filter((e) => e.id === entry.id);
      res.json(publicEntry ?? entry);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get catalog entry' });
    }
  });

  // ── Admin catalog ─────────────────────────────────────────────────────

  app.get('/api/admin/catalog', requireAdmin, async (_req, res) => {
    try {
      res.json(await listCatalogEntries());
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list catalog' });
    }
  });

  app.post('/api/admin/catalog', requireAdmin, createRouteLimiter({ limit: 30 }), async (req, res) => {
    try {
      const { displayName, description, gitUrl, defaultBranch, id, enabled, sortOrder } =
        req.body ?? {};
      if (typeof displayName !== 'string' || typeof gitUrl !== 'string') {
        res.status(400).json({ error: 'displayName and gitUrl are required' });
        return;
      }
      const entry = await createCatalogEntry({
        id: typeof id === 'string' ? slugifyCatalogId(id) : undefined,
        displayName,
        description: typeof description === 'string' ? description : '',
        gitUrl,
        defaultBranch: typeof defaultBranch === 'string' ? defaultBranch : undefined,
        enabled: typeof enabled === 'boolean' ? enabled : true,
        sortOrder: typeof sortOrder === 'number' ? sortOrder : undefined,
      });
      res.status(201).json(entry);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create catalog entry' });
    }
  });

  app.patch('/api/admin/catalog/:id', requireAdmin, async (req, res) => {
    try {
      const entry = await updateCatalogEntry(req.params.id, req.body ?? {});
      res.json(entry);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update catalog entry' });
    }
  });

  app.delete('/api/admin/catalog/:id', requireAdmin, async (req, res) => {
    try {
      await deleteCatalogEntry(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete catalog entry' });
    }
  });

  app.post(
    '/api/admin/catalog/:id/analyze',
    requireAdmin,
    createRouteLimiter({ limit: 10 }),
    async (req, res) => {
      try {
        const entry = await getCatalogEntry(req.params.id);
        if (!entry) {
          res.status(404).json({ error: 'Catalog entry not found' });
          return;
        }

        const remoteHead = await getRemoteHead(entry.gitUrl, entry.defaultBranch);
        const result = await startAnalyzeJob(runnerDeps, {
          repoUrl: entry.gitUrl,
          registryName: entry.id,
          catalogEntryId: entry.id,
          skipIfCommit: entry.lastIndexedCommit,
          defaultBranch: entry.defaultBranch,
          force: !!req.body?.force,
          embeddings: !!req.body?.embeddings,
        });

        if (result.skipped) {
          res.json({ skipped: true, reason: result.reason, remoteHead });
          return;
        }

        res.status(202).json({ jobId: result.jobId, status: result.status, remoteHead });
      } catch (err: any) {
        if (err.message?.includes('already in progress')) {
          res.status(409).json({ error: err.message });
          return;
        }
        res.status(500).json({ error: err.message || 'Failed to start analysis' });
      }
    },
  );

};

/** Register before `express.json()` so the raw body is available for HMAC verification. */
export const mountGithubWebhook = (app: Express, deps: MountNexusRoutesDeps): void => {
  const runnerDeps: AnalyzeRunnerDeps = {
    jobManager: deps.jobManager,
    backend: deps.backend,
    acquireRepoLock: deps.acquireRepoLock,
    releaseRepoLock: deps.releaseRepoLock,
  };

  app.post(
    '/api/webhooks/github',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

      if (secret) {
        const sig = req.headers['x-hub-signature-256'];
        if (typeof sig !== 'string' || !verifyGithubSignature(secret, sig, rawBody)) {
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
      }

      const event = req.headers['x-github-event'];
      if (event !== 'push') {
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      let payload: any;
      try {
        payload = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
      } catch {
        res.status(400).json({ error: 'Invalid JSON' });
        return;
      }

      const repoUrl =
        payload?.repository?.html_url || payload?.repository?.clone_url || '';
      const after = typeof payload?.after === 'string' ? payload.after : '';

      if (!repoUrl || !after) {
        res.status(400).json({ error: 'Invalid push payload' });
        return;
      }

      const entry = await findCatalogByGitUrl(repoUrl);
      if (!entry || !entry.enabled) {
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      if (entry.lastIndexedCommit === after) {
        res.status(200).json({ ok: true, skipped: true });
        return;
      }

      try {
        const result = await startAnalyzeJob(runnerDeps, {
          repoUrl: entry.gitUrl,
          registryName: entry.id,
          catalogEntryId: entry.id,
          defaultBranch: entry.defaultBranch,
          force: false,
        });
        res.status(202).json({ ok: true, jobId: result.jobId, status: result.status });
      } catch (err: any) {
        if (err.message?.includes('already in progress')) {
          res.status(202).json({ ok: true, queued: false, reason: err.message });
          return;
        }
        logger.error({ err }, 'Webhook analyze failed');
        res.status(500).json({ error: err.message || 'Analyze failed' });
      }
    },
  );
};

function verifyGithubSignature(secret: string, header: string, rawBody?: Buffer): boolean {
  if (!rawBody) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  } catch {
    return false;
  }
}
