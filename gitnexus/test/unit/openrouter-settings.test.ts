import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "../../src/server/analyze-job.js";
import { mountNexusRoutes } from "../../src/server/nexus/mount-nexus-routes.js";
import {
	FREE_DOC_MODEL,
	getOpenRouterSettingsPublic,
	resolveDocModel,
} from "../../src/server/nexus/openrouter-settings.js";
import { sealSession } from "../../src/server/nexus/session.js";

describe("openrouter-settings", () => {
	let tmpHome: string;
	let savedGitnexusHome: string | undefined;
	let savedOpenRouterKey: string | undefined;
	let savedDocModel: string | undefined;

	beforeEach(async () => {
		tmpHome = await mkdtemp(path.join(tmpdir(), "nexus-or-"));
		savedGitnexusHome = process.env.GITNEXUS_HOME;
		savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
		savedDocModel = process.env.NEXUS_DOC_MODEL;
		process.env.GITNEXUS_HOME = tmpHome;
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.NEXUS_DOC_MODEL;
	});

	afterEach(async () => {
		await rm(tmpHome, { recursive: true, force: true });
		if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
		else process.env.GITNEXUS_HOME = savedGitnexusHome;
		if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
		if (savedDocModel === undefined) delete process.env.NEXUS_DOC_MODEL;
		else process.env.NEXUS_DOC_MODEL = savedDocModel;
	});

	it("resolveDocModel always returns openrouter/free", () => {
		process.env.NEXUS_DOC_MODEL = "anthropic/claude-3.5-sonnet";
		expect(resolveDocModel()).toBe(FREE_DOC_MODEL);
	});

	it("reads API key from config file when env is unset", async () => {
		await writeFile(
			path.join(tmpHome, "nexus-config.json"),
			JSON.stringify({
				ownerLogin: "admin",
				adminLogins: ["admin"],
				openRouter: { apiKey: "sk-test-file-key", model: FREE_DOC_MODEL },
			}),
			"utf-8",
		);

		const settings = await getOpenRouterSettingsPublic();
		expect(settings.configured).toBe(true);
		expect(settings.model).toBe(FREE_DOC_MODEL);
		expect(settings.apiKeyMasked).toBe("••••-key");
	});

	it("env OPENROUTER_API_KEY overrides file config", async () => {
		await writeFile(
			path.join(tmpHome, "nexus-config.json"),
			JSON.stringify({
				ownerLogin: "admin",
				adminLogins: ["admin"],
				openRouter: { apiKey: "sk-file", model: FREE_DOC_MODEL },
			}),
			"utf-8",
		);
		process.env.OPENROUTER_API_KEY = "sk-env-override";

		const settings = await getOpenRouterSettingsPublic();
		expect(settings.configured).toBe(true);
		expect(settings.apiKeyMasked).toBe("••••ride");
	});
});

describe("openrouter admin settings routes", () => {
	let tmpHome: string;
	let server: Server;
	let baseUrl: string;
	let savedSessionSecret: string | undefined;
	let savedGitnexusHome: string | undefined;
	const jobManager = new JobManager();

	const adminSession = {
		login: "nexus-admin",
		name: "Admin",
		avatarUrl: "https://avatars.example/admin",
		hubUserToken: "hub-token",
		hubSessionId: "sess-admin",
	};

	beforeEach(async () => {
		tmpHome = await mkdtemp(path.join(tmpdir(), "nexus-or-routes-"));
		savedGitnexusHome = process.env.GITNEXUS_HOME;
		savedSessionSecret = process.env.SESSION_SECRET;
		process.env.GITNEXUS_HOME = tmpHome;
		process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars!!";

		await writeFile(
			path.join(tmpHome, "nexus-config.json"),
			JSON.stringify({
				ownerLogin: "nexus-admin",
				adminLogins: ["nexus-admin"],
				authHubUrl: "https://auth.example",
				authHubServiceToken: "a".repeat(32),
			}),
			"utf-8",
		);

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
		const port = typeof addr === "object" && addr ? addr.port : 0;
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

	async function authCookie(login = adminSession.login): Promise<string> {
		const token = await sealSession({ ...adminSession, login });
		return `beskid_nexus_session=${encodeURIComponent(token)}`;
	}

	it("returns 401 for unauthenticated GET openrouter settings", async () => {
		const res = await fetch(`${baseUrl}/api/admin/settings/openrouter`);
		expect(res.status).toBe(401);
	});

	it("returns 403 for non-admin GET openrouter settings", async () => {
		const token = await sealSession({ ...adminSession, login: "random-user" });
		const res = await fetch(`${baseUrl}/api/admin/settings/openrouter`, {
			headers: { Cookie: `beskid_nexus_session=${encodeURIComponent(token)}` },
		});
		expect(res.status).toBe(403);
	});

	it("allows admin to GET and PATCH openrouter settings", async () => {
		const getRes = await fetch(`${baseUrl}/api/admin/settings/openrouter`, {
			headers: { Cookie: await authCookie() },
		});
		expect(getRes.status).toBe(200);
		const initial = await getRes.json();
		expect(initial.model).toBe(FREE_DOC_MODEL);
		expect(initial.configured).toBe(false);

		const patchRes = await fetch(`${baseUrl}/api/admin/settings/openrouter`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Cookie: await authCookie(),
			},
			body: JSON.stringify({ apiKey: "sk-test-admin-key" }),
		});
		expect(patchRes.status).toBe(200);
		const updated = await patchRes.json();
		expect(updated.configured).toBe(true);
		expect(updated.model).toBe(FREE_DOC_MODEL);
		expect(updated.apiKeyMasked).toBe("••••-key");

		const rejectRes = await fetch(`${baseUrl}/api/admin/settings/openrouter`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Cookie: await authCookie(),
			},
			body: JSON.stringify({ model: "anthropic/claude-3.5-sonnet" }),
		});
		expect(rejectRes.status).toBe(400);
	});
});
