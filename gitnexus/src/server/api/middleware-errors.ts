import fs from "node:fs/promises";
import path from "node:path";
import express from "express";

import { logger } from "../../core/logger.js";
import {
	assertString,
	BadRequestError,
	createRouteLimiter,
} from "../validation.js";
import { SPA_FALLBACK_REGEX } from "./contracts.js";

export const resolveWebDistDir = async (
	primaryDir: string,
	fallbackDir: string,
): Promise<string | null> => {
	const envDir = process.env.GITNEXUS_WEB_DIST;
	const dirs = envDir
		? [envDir, primaryDir, fallbackDir]
		: [primaryDir, fallbackDir];
	for (const dir of dirs) {
		try {
			await fs.access(path.join(dir, "index.html"));
			return dir;
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				logger.warn(
					{ err: err.message },
					`[serve] could not access web UI dir ${dir}:`,
				);
			}
		}
	}
	return null;
};

export const landingPageHtml = (): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitNexus</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Outfit,system-ui,-apple-system,sans-serif;background:#06060a;color:#e4e4ed;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
.card{background:#101018;border:1px solid #2a2a3a;border-radius:0.75rem;padding:2rem;max-width:480px;width:100%}
.logo{font-size:1.5rem;font-weight:700;color:#e4e4ed;letter-spacing:-0.02em;margin-bottom:0.25rem}
.subtitle{font-size:0.875rem;color:#8888a0;margin-bottom:1.5rem}
.section-title{font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#5a5a70;margin-bottom:0.75rem}
.endpoint{margin:0.25rem 0;font-size:0.875rem}
.endpoint a{color:#7c3aed;text-decoration:none}
.endpoint a:hover{text-decoration:underline}
.endpoint code{background:#16161f;padding:0.15em 0.4em;border-radius:0.25rem;font-size:0.8rem;color:#8888a0}
.divider{height:1px;background:#1e1e2a;margin:1.25rem 0}
.terminal{background:#0a0a10;border:1px solid #1e1e2a;border-radius:0.5rem;padding:0.75rem 1rem;font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;font-size:0.8rem;color:#8888a0;margin-bottom:1rem;overflow-x:auto}
.terminal .prompt{color:#7c3aed;user-select:none}
.terminal .cmd{color:#e4e4ed}
.link-row{display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;margin-top:0.5rem}
.link-row svg{flex-shrink:0}
a.ext{color:#7c3aed;text-decoration:none;display:inline-flex;align-items:center;gap:0.25rem}
a.ext:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <div class="logo">GitNexus</div>
  <div class="subtitle">API server is running</div>
  <div class="section-title">Endpoints</div>
  <p class="endpoint"><a href="/api/info">/api/info</a> <span style="color:#5a5a70">— Server version &amp; context</span></p>
  <p class="endpoint"><a href="/api/repos">/api/repos</a> <span style="color:#5a5a70">— Indexed repositories</span></p>
  <p class="endpoint"><code>/api/health</code> <span style="color:#5a5a70">— Docker/orchestrator healthcheck</span></p>
  <p class="endpoint"><code>/api/heartbeat</code> <span style="color:#5a5a70">— SSE heartbeat</span></p>
  <p class="endpoint"><code>/api/graph</code> <code>/api/query</code> <code>/api/search</code> <span style="color:#5a5a70">— Data</span></p>
  <p class="endpoint"><code>/api/mcp</code> <span style="color:#5a5a70">— MCP over StreamableHTTP</span></p>
  <div class="divider"></div>
  <div class="section-title">Web UI not found</div>
  <div class="terminal"><span class="prompt">$ </span><span class="cmd">cd gitnexus-web &amp;&amp; npm run build</span></div>
  <div class="link-row">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    <a class="ext" href="https://gitnexus.vercel.app" target="_blank" rel="noopener noreferrer">gitnexus.vercel.app</a>
    <span style="color:#5a5a70">— connects to this server</span>
  </div>
</div>
</body>
</html>`;

export const staticCacheControlSetHeaders = (
	res: express.Response,
	filePath: string,
): void => {
	if (filePath.endsWith(".html")) {
		res.setHeader("Cache-Control", "no-cache");
	} else {
		res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
	}
};

export const registerWebUI = (
	app: express.Express,
	staticDir: string | null,
): void => {
	if (staticDir) {
		app.use(
			express.static(staticDir, {
				setHeaders: staticCacheControlSetHeaders,
			}),
		);
		// ⚠ This must remain the LAST route before the global error handler.
		// The regex excludes /api paths AND paths with file extensions (.js, .css, etc.)
		// so missing assets get real 404s instead of the SPA HTML.
		// Adding routes below this will be unreachable for non-API, non-asset paths.
		// Rate-limited (CodeQL js/missing-rate-limiting): the SPA fallback
		// serves a constant index.html, but the FS access from a route handler
		// is enough to trip the analyzer. The limit is generous (300 rpm/IP =
		// 5 req/s sustained) so that multi-tab browser navigation, prefetch,
		// and service-worker revalidation do not produce 429s for legitimate
		// SPA users. At this rate, real browser navigation is extremely
		// unlikely to hit the limit in practice, so the cosmetic issue of
		// JSON-on-429 to a browser is a low-likelihood path. Content
		// negotiation on the 429 (returning the SPA shell to HTML clients
		// instead of `{ error: '...' }`) would require swapping
		// express-rate-limit's `message` for a `handler` function and is
		// deferred to keep this PR focused on closing the CodeQL alert.
		app.get(
			SPA_FALLBACK_REGEX,
			createRouteLimiter({ limit: 300 }),
			(_req, res) => {
				res.sendFile(path.join(staticDir, "index.html"));
			},
		);
	} else {
		app.get("/", (_req, res) => {
			res.type("html").send(landingPageHtml());
		});
	}
};

export const statusFromError = (err: any): number => {
	// Validation helpers throw BadRequestError / ForbiddenError with a typed
	// .status field — honor it before falling back to message-string matching.
	if (err instanceof BadRequestError) return err.status;
	const msg = String(err?.message ?? "");
	if (msg.includes("No indexed repositories") || msg.includes("not found"))
		return 404;
	if (msg.includes("Multiple repositories")) return 400;
	return 500;
};

export const requestedRepo = (req: express.Request): string | undefined => {
	const fromQuery =
		typeof req.query.repo === "string" ? req.query.repo : undefined;
	if (fromQuery) return fromQuery;

	if (
		req.body &&
		typeof req.body === "object" &&
		typeof req.body.repo === "string"
	) {
		return req.body.repo;
	}

	return undefined;
};

/**
 * Handle a GET /api/file request body. Extracted from createServer's route
 * registration so it can be unit-tested without spinning up an HTTP server
 * — calling app.get(...) inside a test triggers CodeQL's
 * js/missing-rate-limiting query, which is appropriate for production
 * route handlers but a false positive for tests of the handler logic.
 *
 * The function takes the express req and res (typed loosely so test code
 * can pass minimal mocks) plus the resolved repo path. All path-traversal
 * containment is done inline at the readFile sink with the canonical
 * path.relative idiom for CodeQL js/path-injection recognition.
 */
export const handleFileRequest = async (
	req: { query: any },
	res: {
		status: (code: number) => { json: (body: any) => void };
		json: (body: any) => void;
	},
	repoPath: string,
): Promise<void> => {
	try {
		// Type-confusion guard — req.query.path is `string | string[] | ParsedQs`.
		// Without this, an attacker could pass `?path=a&path=b` to bypass the
		// length-bound traversal check below (CodeQL js/type-confusion-through-
		// parameter-tampering, same class as the /api/grep critical fix).
		const rawFilePath = req.query.path;
		if (rawFilePath === undefined || rawFilePath === "") {
			res.status(400).json({ error: "Missing path" });
			return;
		}
		const filePath = assertString(rawFilePath, "path");

		// Path-injection containment — inline at the sink with the canonical
		// path.relative idiom that CodeQL's js/path-injection sanitizer
		// recognizes. assertSafePath in validation.ts performs the equivalent
		// check, but cross-module helpers are not followed by CodeQL's
		// interprocedural analysis for path-traversal sanitization in JS, so
		// the barrier must be visible inline at the readFile sink.
		const repoRoot = path.resolve(repoPath);
		const fullPath = path.resolve(repoRoot, filePath);
		const fullRel = path.relative(repoRoot, fullPath);
		if (fullRel.startsWith("..") || path.isAbsolute(fullRel)) {
			res.status(403).json({ error: "Path traversal denied" });
			return;
		}

		const raw = await fs.readFile(fullPath, "utf-8");

		// Optional line-range support: ?startLine=10&endLine=50
		// Returns only the requested slice (0-indexed), plus metadata.
		const startLine =
			req.query.startLine !== undefined ? Number(req.query.startLine) : undefined;
		const endLine =
			req.query.endLine !== undefined ? Number(req.query.endLine) : undefined;

		if (startLine !== undefined && Number.isFinite(startLine)) {
			const lines = raw.split("\n");
			const start = Math.max(0, startLine);
			const end =
				endLine !== undefined && Number.isFinite(endLine)
					? Math.min(lines.length, endLine + 1)
					: lines.length;
			res.json({
				content: lines.slice(start, end).join("\n"),
				startLine: start,
				endLine: end - 1,
				totalLines: lines.length,
			});
		} else {
			res.json({ content: raw, totalLines: raw.split("\n").length });
		}
	} catch (err: any) {
		if (err.code === "ENOENT") {
			res.status(404).json({ error: "File not found" });
		} else {
			// statusFromError returns err.status for BadRequestError / ForbiddenError
			// (assertString → 400 on array-form ?path=a&path=b; ForbiddenError → 403
			// on traversal). Falls back to 500 for unrecognized failures.
			res
				.status(statusFromError(err))
				.json({ error: err.message || "Failed to read file" });
		}
	}
};

