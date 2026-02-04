import { describe, expect, test } from "bun:test";
import type { ScanInput } from "../src/schema";
import { applySimulationVerdict } from "../src/simulations/verdict";
import type { AnalysisResult } from "../src/types";

function baseAnalysis(): AnalysisResult {
	return {
		contract: {
			address: "0x1111111111111111111111111111111111111111",
			chain: "ethereum",
			verified: true,
			is_proxy: false,
		},
		findings: [],
		confidence: { level: "high", reasons: [] },
		recommendation: "ok",
	};
}

function calldataInput(): ScanInput {
	return {
		calldata: {
			to: "0x1111111111111111111111111111111111111111",
			data: "0x",
			chain: "1",
		},
	};
}

describe("applySimulationVerdict", () => {
	test("downgrades ok to caution when simulation missing", () => {
		const analysis = baseAnalysis();
		const result = applySimulationVerdict(calldataInput(), analysis);
		expect(result.recommendation).toBe("caution");
	});

	test("does not downgrade when simulation succeeds", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			recommendation: "warning",
			simulation: {
				success: true,
				assetChanges: [],
				approvals: [],
				confidence: "high",
				notes: [],
			},
		};
		const result = applySimulationVerdict(calldataInput(), analysis);
		expect(result.recommendation).toBe("warning");
	});
});
