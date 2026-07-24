import { saveToDb } from "./db";
import { formatResponse } from "./formatter";
import { validateInput } from "./validator";

export class RequestHandler {
	async handleRequest(input: string): Promise<string> {
		const validated = validateInput(input);
		const saved = await saveToDb(validated);
		return formatResponse(saved);
	}
}

export function createHandler(): RequestHandler {
	return new RequestHandler();
}
