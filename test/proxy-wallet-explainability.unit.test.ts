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
	test("renders explorer links for contract/spender/token in default + wallet tx output", () => {
		const analysis = buildBaseAnalysis();
		for (const mode of ["default", "wallet"] as const) {
			const output = stripAnsi(
				renderResultBox(analysis, {
					hasCalldata: true,
					mode,
					sender: "0xfeed00000000000000000000000000000000beef",
				}),
			);

			expect(output).toContain("🔗 EXPLORER LINKS");
			expect(output).toContain(
				"Contract, Token: https://etherscan.io/address/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
			);
			expect(output).toContain(
				"Spender: https://etherscan.io/address/0x000000000022d473030f116ddee9f6b43ac78ba3",
			);
		}
	});

	test("shows fast mode coverage banner in wallet mode output", () => {
		const analysis = buildBaseAnalysis();
		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true, mode: "wallet" }));

		expect(output).toContain("FAST MODE — reduced provider coverage (Etherscan, GoPlus skipped)");
	});

	test("does not show fast mode banner in default mode output", () => {
		const analysis = buildBaseAnalysis();
		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));

		expect(output).not.toContain("FAST MODE");
	});

	test("shows explicit metadata-skipped reason in wallet mode context when metadata is absent", () => {
		const analysis = buildBaseAnalysis();
		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true, mode: "wallet" }));

		expect(output).toContain(
			"Context: verified · age: — · txs: — · metadata: skipped in fast mode for latency",
		);
	});

	test("explains missing metadata in default mode too", () => {
		const analysis = buildBaseAnalysis();
		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true, mode: "default" }));

		expect(output).toContain(
			"Context: verified · age: — · txs: — · metadata: contract age/tx history unavailable from providers",
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

	test("renders decoded signature + args context in default and wallet mode", () => {
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

		const walletOutput = stripAnsi(
			renderResultBox(analysis, { hasCalldata: true, mode: "wallet" }),
		);
		expect(walletOutput).toContain(
			"Action: Approve · token: USDC (0xa0b8...eb48) · spender: 0x0000...8ba3 · amount: UNLIMITED · call: approve(address,uint256)",
		);

		for (const mode of ["default", "wallet"] as const) {
			const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true, mode }));
			expect(output).toContain(
				"Decoded: approve(address,uint256) · args: spender=0x0000...8ba3, amount=115792089237316195423… · selector 0x095ea7b3",
			);
		}
	});

	test("dedupes proxy-related checks so warnings are not repeated", () => {
		const analysis: AnalysisResult = {
			...buildBaseAnalysis(),
			contract: {
				...buildBaseAnalysis().contract,
				is_proxy: true,
				proxy_name: "FiatTokenProxy",
				implementation_name: "FiatTokenV2",
				implementation: "0x1111111111111111111111111111111111111111",
			},
			findings: [
				{ level: "info", code: "PROXY", message: "Proxy detected (eip1967)" },
				{
					level: "warning",
					code: "UPGRADEABLE",
					message: "Upgradeable proxy (eip1967) - code can change",
				},
			],
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		expect(output).toContain("⚠️ Proxy / upgradeable (code can change)");
		expect(output).not.toContain("[UPGRADEABLE]");
		expect(output).not.toContain("[PROXY]");
	});

	test("suppresses dust balance noise and reports no net balance change", () => {
		const analysis: AnalysisResult = {
			...buildBaseAnalysis(),
			simulation: {
				success: true,
				nativeDiff: 1n,
				balances: {
					changes: [
						{
							assetType: "erc20",
							address: "0x1111111111111111111111111111111111111111",
							direction: "in",
							amount: 1n,
							symbol: "aEthWETH",
							decimals: 18,
						},
					],
					confidence: "high",
				},
				approvals: {
					changes: [],
					confidence: "high",
				},
				notes: [],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		expect(output).toContain("No net balance change detected");
		expect(output).not.toContain("received 0");
		expect(output).not.toContain("aEthWETH");
	});
});
