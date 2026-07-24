import { describe, expect, it } from "vitest";

import {
	trackerDeliveryNodeId,
	trackerDeliveryRelation,
} from "../../src/server/nexus/spec-link-index.js";

describe("Tracker delivery link index", () => {
	it("keys Tracker nodes and typed OpenSpec relations by tracker ID plus catalog revision", () => {
		expect(trackerDeliveryNodeId("task-1", "catalog-5")).toBe(
			"tracker:task-1:catalog-5",
		);
		expect(
			trackerDeliveryRelation({
				trackerId: "task-1",
				catalogRevision: "catalog-5",
				standardId: "language--syntax#BSP-REQ-BLOCK",
				relation: "implements",
			}),
		).toMatchObject({
			id: "tracker:task-1:catalog-5->openspec:language--syntax#BSP-REQ-BLOCK:catalog-5",
			from: "tracker:task-1:catalog-5",
			to: "openspec:language--syntax#BSP-REQ-BLOCK:catalog-5",
			relation: "implements",
			catalogRevision: "catalog-5",
		});
	});
});
