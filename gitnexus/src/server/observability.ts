import {
	Registry,
	collectDefaultMetrics,
	Counter,
	Histogram,
	type RegistryContentType,
} from "prom-client";
import type { NextFunction, Request, Response } from "express";

const SERVICE = "gitnexus";

const registry = new Registry();
registry.setDefaultLabels({ service: SERVICE });
collectDefaultMetrics({ register: registry });

const httpRequestDuration = new Histogram({
	name: "http_request_duration_seconds",
	help: "HTTP request duration in seconds",
	labelNames: ["method", "route", "status_code"] as const,
	registers: [registry],
	buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const httpRequestsTotal = new Counter({
	name: "http_requests_total",
	help: "Total HTTP requests",
	labelNames: ["method", "route", "status_code"] as const,
	registers: [registry],
});

function normalizeRoute(path: string): string {
	if (!path || path === "/") return "/";
	if (path.startsWith("/api/")) {
		const parts = path.split("/").filter(Boolean);
		if (parts.length >= 3) {
			return `/${parts.slice(0, 3).join("/")}`;
		}
	}
	return path.length > 80 ? `${path.slice(0, 77)}...` : path;
}

export function observabilityMiddleware(
	req: Request,
	res: Response,
	next: NextFunction,
): void {
	if (req.path === "/metrics") {
		next();
		return;
	}

	const start = performance.now();
	res.on("finish", () => {
		const durationSeconds = (performance.now() - start) / 1000;
		const labels = {
			method: (req.method ?? "GET").toUpperCase(),
			route: normalizeRoute(req.path),
			status_code: String(res.statusCode),
		};
		httpRequestDuration.observe(labels, durationSeconds);
		httpRequestsTotal.inc(labels);
	});
	next();
}

export async function renderMetrics(): Promise<{
	body: string;
	contentType: RegistryContentType;
}> {
	return {
		body: await registry.metrics(),
		contentType: registry.contentType,
	};
}

export function mountMetricsRoute(
	app: import("express").Express,
): void {
	app.get("/metrics", async (_req, res) => {
		const { body, contentType } = await renderMetrics();
		res.set("Content-Type", contentType);
		res.send(body);
	});
}
