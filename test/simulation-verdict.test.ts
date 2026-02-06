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

	test("downgrades ok to caution when simulation reverts", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			simulation: {
				success: false,
				revertReason: "execution reverted: transferFrom failed",
				assetChanges: [],
				approvals: [],
				confidence: "low",
				notes: ["reverted"],
			},
		};
		const result = applySimulationVerdict(calldataInput(), analysis);
		expect(result.recommendation).toBe("caution");
	});

	test("does not downgrade danger when simulation not run", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			recommendation: "danger",
			simulation: {
				success: false,
				revertReason: "Simulation not run",
				assetChanges: [],
				approvals: [],
				confidence: "low",
				notes: ["Simulation not run"],
			},
		};
		const result = applySimulationVerdict(calldataInput(), analysis);
		expect(result.recommendation).toBe("danger");
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
