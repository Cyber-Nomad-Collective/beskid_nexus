import type { Request } from "express";

export interface AuthentikIdentity {
	username: string;
	name: string | null;
	email: string | null;
	groups: string[];
}

type HeaderValues = Record<string, string | string[] | undefined>;

const headerValue = (headers: HeaderValues, name: string): string => {
	const value = headers[name];
	return (Array.isArray(value) ? value[0] : value || "").trim();
};

/**
 * Trust only the identity headers copied by Caddy after Authentik forward_auth.
 * The service is not an identity provider and must never accept a browser
 * cookie, bearer token, or user-controlled substitute for these headers.
 */
export const resolveAuthentikIdentity = (
	headers: HeaderValues,
): AuthentikIdentity | null => {
	const username = headerValue(headers, "x-authentik-username");
	if (!username) return null;
	const groups = headerValue(headers, "x-authentik-groups")
		.split(/[|,]/u)
		.map((group) => group.trim())
		.filter(Boolean);
	return {
		username,
		name: headerValue(headers, "x-authentik-name") || null,
		email: headerValue(headers, "x-authentik-email") || null,
		groups,
	};
};

export const getAuthentikIdentity = (req: Request): AuthentikIdentity | null =>
	resolveAuthentikIdentity(req.headers);

const normalizedList = (value: string | undefined): Set<string> =>
	new Set(
		(value || "")
			.split(",")
			.map((item) => item.trim().toLowerCase())
			.filter(Boolean),
	);

export const isAuthentikAdmin = (identity: AuthentikIdentity): boolean => {
	const allowedUsers = normalizedList(process.env.NEXUS_AUTHENTIK_ADMIN_USERS);
	if (allowedUsers.has(identity.username.toLowerCase())) return true;
	const allowedGroups = normalizedList(process.env.NEXUS_AUTHENTIK_ADMIN_GROUPS);
	return identity.groups.some((group) => allowedGroups.has(group.toLowerCase()));
};
