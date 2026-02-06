import { describe, expect, test } from "bun:test";
import { renderResultBox } from "../src/cli/ui";
import type { AnalysisResult } from "../src/types";

function stripAnsi(input: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

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

describe("cli risk label with simulation failures", () => {
	test("AI enabled + simulation failed + calldata never shows SAFE", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			ai: {
				risk_score: 10,
				summary: "No issues detected.",
				concerns: [],
				model: "test-model",
				provider: "openai",
			},
			simulation: {
				success: false,
				revertReason: "Simulation failed",
				assetChanges: [],
				approvals: [],
				confidence: "low",
				notes: ["Simulation failed"],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		const riskLine = output.split("\n").find((line) => line.includes("📊 RISK:"));
		expect(riskLine).toBeDefined();
		expect(riskLine).not.toContain("SAFE");
		expect(riskLine).toContain("LOW");
		expect(output).not.toContain("- None detected");
	});

	test("AI enabled + simulation missing + calldata never shows SAFE", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			ai: {
				risk_score: 5,
				summary: "No issues detected.",
				concerns: [],
				model: "test-model",
				provider: "openai",
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		const riskLine = output.split("\n").find((line) => line.includes("📊 RISK:"));
		expect(riskLine).toBeDefined();
		expect(riskLine).not.toContain("SAFE");
		expect(riskLine).toContain("LOW");
		expect(output).not.toContain("- None detected");
	});

	test("AI enabled + simulation success (low confidence) + calldata never shows SAFE", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			ai: {
				risk_score: 5,
				summary: "No issues detected.",
				concerns: [],
				model: "test-model",
				provider: "openai",
			},
			simulation: {
				success: true,
				assetChanges: [],
				approvals: [],
				confidence: "low",
				notes: [],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		const riskLine = output.split("\n").find((line) => line.includes("📊 RISK:"));
		expect(riskLine).toBeDefined();
		expect(riskLine).not.toContain("SAFE");
		expect(riskLine).toContain("LOW");
		expect(output).toContain("No balance changes detected (low confidence)");
		expect(output).toContain("- None detected");
	});
});
