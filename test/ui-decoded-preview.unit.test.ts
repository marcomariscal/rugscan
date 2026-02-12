import { describe, expect, test } from "bun:test";
import { renderResultBox } from "../src/cli/ui";
import type { AnalysisResult } from "../src/types";

function stripAnsi(input: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("decoded preview readability", () => {
	test("formats known token amounts in decoded arg preview", () => {
		const analysis: AnalysisResult = {
			contract: {
				address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
				chain: "ethereum",
				name: "USD Coin",
				verified: true,
				confidence: "high",
				is_proxy: false,
			},
			findings: [
				{ level: "safe", code: "VERIFIED", message: "Source code verified: USD Coin" },
				{
					level: "info",
					code: "CALLDATA_DECODED",
					message: "Decoded calldata",
					details: {
						signature: "approve(address,uint256)",
						functionName: "approve",
						selector: "0x095ea7b3",
						args: {
							spender: "0x0000000000000000000000000000000000000001",
							amount: "500606000",
						},
					},
				},
			],
			recommendation: "ok",
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		expect(output).toContain("amount=500.606 USDC");
		expect(output).not.toContain("amount=500606000");
	});
});
