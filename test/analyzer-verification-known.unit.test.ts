import { describe, expect, test } from "bun:test";
import type { AnalyzerDeps } from "../src/analyzer";
import { analyze } from "../src/analyzer";

describe("analyzer verificationKnown", () => {
	test("marks verificationKnown when Etherscan returns unverified (even if Sourcify fails)", async () => {
		const deps: AnalyzerDeps = {
			defillama: {
				matchProtocol: async () => null,
			},
			etherscan: {
				getAddressLabels: async () => null,
				getContractData: async () => {
					return {
						verified: false,
						name: undefined,
						source: undefined,
						age_days: undefined,
						tx_count: undefined,
						creator: undefined,
					};
				},
			},
			goplus: {
				getTokenSecurity: async () => ({ data: null }),
			},
			proxy: {
				isContract: async () => true,
				detectProxy: async () => ({ is_proxy: false }),
			},
			sourcify: {
				checkVerification: async () => {
					throw new Error("sourcify failed");
				},
			},
		};

		const result = await analyze(
			"0x000000000000000000000000000000000000dead",
			"ethereum",
			{
				rpcUrls: { ethereum: "http://localhost:8545" },
				etherscanKeys: { ethereum: "x" },
			},
			undefined,
			{ deps },
		);

		const unverified = result.findings.find((f) => f.code === "UNVERIFIED");
		expect(unverified).toBeTruthy();
		expect(unverified?.level).toBe("danger");

		expect(result.confidence.level).toBe("low");
		expect(result.confidence.reasons).toContain("source not verified");
	});
});
