import {
	buildLoginUrl,
	verifyHandoffToken,
} from "@beskid/auth-client";

import { loadNexusConfigFile } from "./nexus-config.js";
import type { NexusSessionPayload } from "./types.js";

const resolveHubUrl = async (): Promise<string | null> => {
	const file = await loadNexusConfigFile();
	const base =
		file?.authHubUrl?.trim() || process.env.AUTH_HUB_PUBLIC_URL?.trim() || "";
	return base || null;
};

const resolveServiceToken = async (): Promise<string | null> => {
	const file = await loadNexusConfigFile();
	const token =
		file?.authHubServiceToken?.trim() ||
		file?.authHubHandoffSecret?.trim() ||
		process.env.AUTH_HUB_SECRET?.trim() ||
		"";
	return token.length >= 32 ? token : null;
};

export const authHubLoginUrl = async (): Promise<string | null> => {
	const base = await resolveHubUrl();
	if (!base) return null;
	return buildLoginUrl(base, "nexus");
};

export const verifyHubHandoff = async (
	token: string,
): Promise<NexusSessionPayload | null> => {
	const serviceToken = await resolveServiceToken();
	if (!serviceToken) return null;
	const payload = await verifyHandoffToken(serviceToken, token, "nexus");
	if (!payload) return null;
	return {
		hubUserToken: payload.hubUserToken,
		hubSessionId: payload.sessionId,
		login: payload.login,
		avatarUrl: payload.avatarUrl,
		name: payload.name,
	};
};
