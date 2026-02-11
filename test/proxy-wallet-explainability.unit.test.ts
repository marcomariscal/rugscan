import { describe, expect, test } from "bun:test";
import { renderResultBox } from "../src/cli/ui";
import { MAX_UINT256 } from "../src/constants";
import type { AnalysisResult } from "../src/types";

function stripAnsi(input: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function buildBaseAnalysis(): AnalysisResult {
	return {
		contract: {
			address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
			chain: "ethereum",
			name: "USD Coin",
			verified: true,
			confidence: "high",
			is_proxy: false,
		},
		findings: [],
		recommendation: "warning",
		intent: "Approve USDC allowance",
		simulation: {
			success: true,
			balances: { changes: [], confidence: "high" },
			approvals: {
				changes: [
					{
						standard: "erc20",
						token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
						owner: "0xfeed00000000000000000000000000000000beef",
						spender: "0x000000000022d473030f116ddee9f6b43ac78ba3",
						amount: MAX_UINT256,
						scope: "token",
						symbol: "USDC",
						decimals: 6,
					},
				],
				confidence: "high",
			},
			notes: [],
		},
	};
}

describe("proxy wallet explainability output", () => {
	test("renders clear explorer links for contract/spender/token in tx output", () => {
		const analysis = buildBaseAnalysis();
		const output = stripAnsi(
			renderResultBox(analysis, {
				hasCalldata: true,
				mode: "wallet",
				sender: "0xfeed00000000000000000000000000000000beef",
			}),
		);

		expect(output).toContain("🔗 EXPLORER LINKS");
		expect(output).toContain(
			"https://etherscan.io/address/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
		);
		expect(output).toContain(
			"https://etherscan.io/address/0x000000000022d473030f116ddee9f6b43ac78ba3",
		);
	});

	test("shows explicit metadata-skipped reason in wallet mode context when metadata is absent", () => {
		const analysis = buildBaseAnalysis();
		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true, mode: "wallet" }));

		expect(output).toContain(
			"Context: verified · age: — · txs: — · metadata: skipped in wallet mode for latency",
		);
	});

	test("states block reason clearly when simulation coverage is incomplete", () => {
		const analysis: AnalysisResult = {
			...buildBaseAnalysis(),
			recommendation: "ok",
			simulation: {
				success: true,
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: ["Hint: upstream RPC returned truncated trace results."],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true, mode: "wallet" }));

		expect(output).toContain(
			"INCONCLUSIVE: balance coverage incomplete; approval coverage incomplete",
		);
		expect(output).toContain("BLOCK — simulation coverage incomplete");
		expect(output).toContain(
			"This block happened because balance/approval coverage is incomplete.",
		);
		expect(output).toContain("upstream RPC returned truncated trace results");
	});

	test("renders readable approve action line with decoded signature/selector context", () => {
		const analysis: AnalysisResult = {
			...buildBaseAnalysis(),
			findings: [
				{
					level: "info",
					code: "CALLDATA_DECODED",
					message: "Decoded calldata: approve(spender: 0x0000…8ba3, amount: MAX_UINT256)",
					details: {
						selector: "0x095ea7b3",
						signature: "approve(address,uint256)",
						functionName: "approve",
						args: {
							spender: "0x000000000022d473030f116ddee9f6b43ac78ba3",
							amount: MAX_UINT256.toString(),
						},
						argNames: ["spender", "amount"],
					},
				},
			],
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true, mode: "wallet" }));

		expect(output).toContain(
			"Action: Approve · token: USDC (0xa0b8...eb48) · spender: 0x0000...8ba3 · amount: UNLIMITED · call: approve(address,uint256)",
		);
		expect(output).toContain("Decoded: approve(address,uint256) · selector 0x095ea7b3");
	});
});
