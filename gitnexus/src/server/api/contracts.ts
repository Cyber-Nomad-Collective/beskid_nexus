import type { Express } from "express";
import type { LocalBackend } from "../../mcp/local/local-backend.js";
import type { JobManager } from "../analyze-job.js";

export type ResolveRepo = (
	repoName?: string,
	isRetry?: boolean,
	req?: any,
) => Promise<any>;

export interface ServerRouteDeps {
	app: Express;
	backend: LocalBackend;
	jobManager: JobManager;
	acquireRepoLock: (repoPath: string) => string | null;
	releaseRepoLock: (repoPath: string) => void;
	resolveRepo: ResolveRepo;
}

/**
 * Determine whether an HTTP Origin header value is allowed by CORS policy.
 *
 * Permitted origins:
 * - No origin (non-browser requests such as curl or server-to-server calls)
 * - http://localhost:<port> — local development
 * - http://127.0.0.1:<port> — loopback alias
 * - RFC 1918 private/LAN networks (any port):
 *     10.0.0.0/8      → 10.x.x.x
 *     172.16.0.0/12   → 172.16.x.x – 172.31.x.x
 *     192.168.0.0/16  → 192.168.x.x
 * - https://gitnexus.vercel.app — the deployed GitNexus web UI
 *
 * @param origin - The value of the HTTP `Origin` request header, or `undefined`
 *                 when the header is absent (non-browser request).
 * @returns `true` if the origin is allowed, `false` otherwise.
 */
export const isAllowedOrigin = (origin: string | undefined): boolean => {
	if (origin === undefined) {
		// Non-browser requests (curl, server-to-server) have no Origin header
		return true;
	}

	if (
		origin.startsWith("http://localhost:") ||
		origin === "http://localhost" ||
		origin.startsWith("http://127.0.0.1:") ||
		origin === "http://127.0.0.1" ||
		origin.startsWith("http://[::1]:") ||
		origin === "http://[::1]" ||
		origin === "https://gitnexus.vercel.app"
	) {
		return true;
	}

	// RFC 1918 private network ranges — allow any port on these hosts.
	// We parse the hostname out of the origin URL and check against each range.
	let hostname: string;
	let protocol: string;
	try {
		const parsed = new URL(origin);
		hostname = parsed.hostname;
		protocol = parsed.protocol;
	} catch {
		// Malformed origin — reject
		return false;
	}

	// Only allow HTTP(S) origins — reject ftp://, file://, etc.
	if (protocol !== "http:" && protocol !== "https:") return false;

	const octets = hostname.split(".").map(Number);
	if (
		octets.length !== 4 ||
		octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
	) {
		return false;
	}

	const [a, b] = octets;

	// 10.0.0.0/8
	if (a === 10) return true;
	// 172.16.0.0/12  →  172.16.x.x – 172.31.x.x
	if (a === 172 && b >= 16 && b <= 31) return true;
	// 192.168.0.0/16
	if (a === 192 && b === 168) return true;

	return false;
};

export const SPA_FALLBACK_REGEX = /^(?!\/api(?:\/|$))(?!.*\.\w{1,10}$).*/;


