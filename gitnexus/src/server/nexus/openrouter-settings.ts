import { logger } from "../../core/logger.js";
import { loadNexusConfigFile, saveNexusConfigFile } from "./nexus-config.js";
import type { NexusConfigFile } from "./types.js";

export const FREE_DOC_MODEL = "openrouter/free";

export interface OpenRouterSettingsPublic {
	configured: boolean;
	model: string;
	apiKeyMasked: string | null;
}

const maskApiKey = (key: string): string => {
	const trimmed = key.trim();
	if (trimmed.length <= 4) return "••••";
	return `••••${trimmed.slice(-4)}`;
};

export const resolveOpenRouterApiKey = async (): Promise<string | null> => {
	const envKey = process.env.OPENROUTER_API_KEY?.trim();
	if (envKey) return envKey;

	const file = await loadNexusConfigFile();
	const fileKey = file?.openRouter?.apiKey?.trim();
	return fileKey || null;
};

/** Always use the free OpenRouter model — env/file overrides are ignored. */
export const resolveDocModel = (): string => {
	const envModel = process.env.NEXUS_DOC_MODEL?.trim();
	if (envModel && envModel !== FREE_DOC_MODEL) {
		logger.warn(
			{ requested: envModel, using: FREE_DOC_MODEL },
			"NEXUS_DOC_MODEL ignored; code-doc pipeline uses free model only",
		);
	}
	return FREE_DOC_MODEL;
};

export const isOpenRouterConfigured = async (): Promise<boolean> => {
	const key = await resolveOpenRouterApiKey();
	return !!key;
};

export const getOpenRouterSettingsPublic =
	async (): Promise<OpenRouterSettingsPublic> => {
		const key = await resolveOpenRouterApiKey();
		return {
			configured: !!key,
			model: FREE_DOC_MODEL,
			apiKeyMasked: key ? maskApiKey(key) : null,
		};
	};

export const updateOpenRouterSettings = async (body: {
	apiKey?: string;
}): Promise<OpenRouterSettingsPublic> => {
	const existing = (await loadNexusConfigFile()) ?? {
		ownerLogin: "",
		adminLogins: [],
	};

	const nextKey =
		typeof body.apiKey === "string" && body.apiKey.trim()
			? body.apiKey.trim()
			: existing.openRouter?.apiKey?.trim();

	const config: NexusConfigFile = {
		...existing,
		openRouter: {
			apiKey: nextKey,
			model: FREE_DOC_MODEL,
		},
	};

	await saveNexusConfigFile(config);
	return getOpenRouterSettingsPublic();
};
