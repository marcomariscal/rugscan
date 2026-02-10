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
			confidence: "high",
			is_proxy: false,
		},
		findings: [],
		recommendation: "ok",
	};
}

describe("cli recommendation label with simulation failures", () => {
	test("simulation failed + calldata never shows OK", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			simulation: {
				success: false,
				revertReason: "Simulation failed",
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: ["Simulation failed"],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		const verdictLine = output.split("\n").find((line) => line.includes("👉 VERDICT:"));
		expect(verdictLine).toBeDefined();
		expect(verdictLine).not.toContain("OK");
		expect(verdictLine).toContain("CAUTION");
		expect(output).toContain("BLOCK");
		expect(output).not.toContain("- None detected");
	});

	test("simulation missing + calldata never shows OK", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		const verdictLine = output.split("\n").find((line) => line.includes("👉 VERDICT:"));
		expect(verdictLine).toBeDefined();
		expect(verdictLine).not.toContain("OK");
		expect(verdictLine).toContain("CAUTION");
		expect(output).toContain("BLOCK");
		expect(output).not.toContain("- None detected");
	});

	test("simulation success (low confidence) + calldata never shows OK", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			simulation: {
				success: true,
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: [],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		const verdictLine = output.split("\n").find((line) => line.includes("👉 VERDICT:"));
		expect(verdictLine).toBeDefined();
		expect(verdictLine).not.toContain("OK");
		expect(verdictLine).toContain("CAUTION");
		expect(output).toContain("BLOCK");
		expect(output).toContain("Could not verify all balance changes; treat this as higher risk.");
		expect(output).toContain("Approval coverage is incomplete; treat this as higher risk.");
	});

	test("checks findings are severity-ordered and capped by default", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			contract: {
				...baseAnalysis().contract,
				verified: false,
			},
			recommendation: "warning",
			findings: [
				{ level: "danger", code: "UNVERIFIED", message: "Source code is not verified" },
				{ level: "danger", code: "KNOWN_PHISHING", message: "Known phishing label" },
				{ level: "warning", code: "UPGRADEABLE", message: "Upgradeable proxy" },
				{ level: "warning", code: "NEW_CONTRACT", message: "Recently deployed" },
				{ level: "warning", code: "UNLIMITED_APPROVAL", message: "Unlimited approval" },
				{ level: "info", code: "LOW_ACTIVITY", message: "Low transaction activity" },
			],
			simulation: {
				success: true,
				balances: { changes: [], confidence: "high" },
				approvals: { changes: [], confidence: "high" },
				notes: [],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		expect(output).toContain("+2 more (use --verbose)");

		const phishingIndex = output.indexOf("KNOWN_PHISHING");
		const unverifiedIndex = output.indexOf("UNVERIFIED");
		const upgradeableIndex = output.indexOf("UPGRADEABLE");
		expect(phishingIndex).toBeGreaterThanOrEqual(0);
		expect(unverifiedIndex).toBeGreaterThanOrEqual(0);
		expect(upgradeableIndex).toBeGreaterThanOrEqual(0);
		expect(phishingIndex).toBeLessThan(unverifiedIndex);
		expect(unverifiedIndex).toBeLessThan(upgradeableIndex);
	});
});
