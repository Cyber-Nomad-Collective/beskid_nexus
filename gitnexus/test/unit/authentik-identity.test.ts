import { describe, expect, it } from "vitest";
import { resolveAuthentikIdentity } from "../../src/server/nexus/authentik-identity.js";

describe("resolveAuthentikIdentity", () => {
	it("accepts an Authentik proxy identity and splits forwarded groups", () => {
		const identity = resolveAuthentikIdentity({
			"x-authentik-username": "mikserek",
			"x-authentik-name": "Mikołaj",
			"x-authentik-email": "miks@example.test",
			"x-authentik-groups": "nexus-admin|maintainers",
		});

		expect(identity).toEqual({
			username: "mikserek",
			name: "Mikołaj",
			email: "miks@example.test",
			groups: ["nexus-admin", "maintainers"],
		});
	});

	it("rejects a request without the Authentik username header", () => {
		expect(resolveAuthentikIdentity({ "x-authentik-groups": "nexus-admin" })).toBeNull();
	});
});
