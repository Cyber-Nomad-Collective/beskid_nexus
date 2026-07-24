import { logMessage } from "./logger";
import { sanitize } from "./validator";

export function processRequest(input: string): string {
	const clean = sanitize(input);
	return logMessage("info", `Processing: ${clean}`);
}

export function errorMiddleware(error: string): string {
	return logMessage("error", error);
}
