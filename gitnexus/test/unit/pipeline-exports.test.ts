import { describe, expect, it } from "vitest";
import { runPipelineFromRepo } from "../../src/core/ingestion/pipeline.js";

describe("pipeline", () => {
	it("exports runPipelineFromRepo function", () => {
		expect(typeof runPipelineFromRepo).toBe("function");
	});
});
