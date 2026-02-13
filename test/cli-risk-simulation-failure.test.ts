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
		expect(verdictLine).toContain("BLOCK (SIMULATION FAILED)");
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
		expect(verdictLine).toContain("BLOCK (SIMULATION INCOMPLETE)");
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
				notes: ["Unable to read pre-transaction approvals (missing previous block)."],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		const verdictLine = output.split("\n").find((line) => line.includes("👉 VERDICT:"));
		expect(verdictLine).toBeDefined();
		expect(verdictLine).not.toContain("OK");
		expect(verdictLine).toContain("BLOCK (SIMULATION INCOMPLETE)");
		expect(output).toContain("BLOCK");
		expect(output).toContain(
			"Balance changes couldn't be fully verified — treat with extra caution.",
		);
		expect(output).toContain("Couldn't verify approvals — treat with extra caution.");
		expect(output).not.toContain("INCONCLUSIVE:");
		expect(output).toContain(
			"BLOCK — simulation coverage incomplete (balance coverage incomplete; approval coverage incomplete).",
		);
		expect(output).toContain("Unable to read pre-transaction approvals (missing previous block)");
	});

	test("filters swap-specific simulation hints from non-swap approval flows", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			intent: "Approve spender",
			simulation: {
				success: false,
				revertReason: "Simulation failed",
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: ["Hint: transaction value is 0; swaps often require non-zero ETH value."],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		expect(output).not.toContain("swaps often require non-zero ETH value");
	});

	test("renders user-facing simulation backend failures", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			simulation: {
				success: false,
				revertReason: "Anvil exited with code 1",
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: ["Hint: Anvil exited with code 1"],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		expect(output).not.toContain("Anvil exited with code 1");
		expect(output).toContain("Local simulation backend was unavailable.");
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

		// UNVERIFIED is now absorbed into the hardcoded verification-state line
		// ("⚠️ Source not verified") so it shouldn't appear as a separate [UNVERIFIED] finding.
		expect(output).not.toContain("[UNVERIFIED]");
		expect(output).toContain("⚠️ Source not verified (or unknown)");

		const phishingIndex = output.indexOf("KNOWN_PHISHING");
		const newContractIndex = output.indexOf("NEW_CONTRACT");
		expect(output).toContain("⚠️ Proxy / upgradeable (code can change)");
		expect(output).not.toContain("[UPGRADEABLE]");
		expect(phishingIndex).toBeGreaterThanOrEqual(0);
		expect(newContractIndex).toBeGreaterThanOrEqual(0);
		expect(phishingIndex).toBeLessThan(newContractIndex);
	});

	test("explorer links suppress zero-address entries", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			simulation: {
				success: true,
				balances: { changes: [], confidence: "high" },
				approvals: {
					changes: [
						{
							standard: "erc20",
							token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
							owner: "0xfeed00000000000000000000000000000000beef",
							spender: "0x0000000000000000000000000000000000000000",
							amount: 0n,
							scope: "token",
						},
					],
					confidence: "high",
				},
				notes: [],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		// The zero-address spender appears in the approval line (revoke), but
		// should NOT appear in the EXPLORER LINKS section as a link target.
		const explorerSection = output.slice(output.indexOf("EXPLORER LINKS"));
		expect(explorerSection).not.toContain("0x0000000000000000000000000000000000000000");
		// Confirm the section exists and has other links
		expect(output).toContain("EXPLORER LINKS");
	});

	test("custom revert ERC20InsufficientBalance decodes to readable message", () => {
		// ERC20InsufficientBalance(address,uint256,uint256) selector: 0xe450d38c
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			simulation: {
				success: false,
				revertReason:
					"execution reverted: custom error 0xe450d38c000000000000000000000000feed00000000000000000000000000000000beef00000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000001000",
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: [],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		expect(output).toContain("ERC20InsufficientBalance");
		expect(output).toContain("selector 0xe450d38c");
	});

	test("unknown custom revert preserves selector with data summary", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			simulation: {
				success: false,
				revertReason: "execution reverted: custom error 0xdeadbeef",
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: [],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		expect(output).toContain("selector 0xdeadbeef");
		expect(output).toContain("contract error");
	});
});
