import { describe, expect, test } from "bun:test";
import { type AnalyzerDeps, analyze } from "../src/analyzer";
import type { TokenSecurity, VerificationResult } from "../src/types";

function baseDeps(): AnalyzerDeps {
	return {
		ai: {
			analyzeRisk: async () => {
				throw new Error("ai disabled");
			},
		},
		defillama: {
			matchProtocol: async () => null,
		},
		etherscan: {
			getAddressLabels: async () => null,
			getContractData: async () => null,
		},
		goplus: {
			getTokenSecurity: async () => ({ data: null }),
		},
		proxy: {
			isContract: async () => true,
			detectProxy: async () => ({ is_proxy: false }),
		},
		sourcify: {
			checkVerification: async () => ({ verified: false, verificationKnown: false }),
		},
	};
}

async function analyzeWith(options: {
	verification: VerificationResult;
	tokenSecurity?: TokenSecurity | null;
}): Promise<Awaited<ReturnType<typeof analyze>>> {
	const deps = baseDeps();
	const depsWithOverrides: AnalyzerDeps = {
		...deps,
		sourcify: {
			checkVerification: async () => options.verification,
		},
		goplus: {
			getTokenSecurity: async () => ({ data: options.tokenSecurity ?? null }),
		},
	};

	return await analyze(
		"0x000000000000000000000000000000000000dead",
		"ethereum",
		undefined,
		undefined,
		{ deps: depsWithOverrides },
	);
}

describe("analyzer matrix (unit)", () => {
	describe("verification", () => {
		test("verified → VERIFIED finding + ok recommendation", async () => {
			const result = await analyzeWith({
				verification: {
					verified: true,
					verificationKnown: true,
					name: "TestContract",
				},
			});

			expect(result.contract.verified).toBe(true);
			expect(result.findings.some((f) => f.code === "VERIFIED")).toBe(true);
			expect(result.findings.some((f) => f.code === "UNVERIFIED")).toBe(false);
			expect(result.findings.some((f) => f.code === "UNKNOWN_SECURITY")).toBe(false);
			expect(result.recommendation).toBe("ok");
		});

		test("unverified → UNVERIFIED finding + danger recommendation", async () => {
			const result = await analyzeWith({
				verification: {
					verified: false,
					verificationKnown: true,
				},
			});

			expect(result.contract.verified).toBe(false);
			expect(result.findings.some((f) => f.code === "UNVERIFIED")).toBe(true);
			expect(result.recommendation).toBe("danger");
			expect(result.confidence.level).toBe("low");
		});

		test("verification unknown → UNKNOWN_SECURITY finding", async () => {
			const result = await analyzeWith({
				verification: {
					verified: false,
					verificationKnown: false,
				},
			});

			expect(result.contract.verified).toBe(false);
			expect(result.findings.some((f) => f.code === "UNKNOWN_SECURITY")).toBe(true);
			expect(result.findings.some((f) => f.code === "UNVERIFIED")).toBe(false);
			expect(result.confidence.level).toBe("medium");
			expect(result.confidence.reasons).toContain("source verification unknown");
		});
	});

	describe("GoPlus token findings mapping", () => {
		const unknownVerification: VerificationResult = {
			verified: false,
			verificationKnown: false,
		};

		test("honeypot → HONEYPOT finding + danger recommendation", async () => {
			const result = await analyzeWith({
				verification: unknownVerification,
				tokenSecurity: {
					is_honeypot: true,
					is_mintable: false,
					can_take_back_ownership: undefined,
					hidden_owner: undefined,
					selfdestruct: false,
					buy_tax: 0,
					sell_tax: 0,
					is_blacklisted: false,
					owner_can_change_balance: false,
				},
			});

			expect(result.findings.some((f) => f.code === "HONEYPOT")).toBe(true);
			expect(result.recommendation).toBe("danger");
		});

		test("mintable → HIDDEN_MINT finding + danger recommendation", async () => {
			const result = await analyzeWith({
				verification: unknownVerification,
				tokenSecurity: {
					is_honeypot: false,
					is_mintable: true,
					can_take_back_ownership: undefined,
					hidden_owner: undefined,
					selfdestruct: false,
					buy_tax: 0,
					sell_tax: 0,
					is_blacklisted: false,
					owner_can_change_balance: false,
				},
			});

			expect(result.findings.some((f) => f.code === "HIDDEN_MINT")).toBe(true);
			expect(result.recommendation).toBe("danger");
		});

		test("blacklist → BLACKLIST finding + warning recommendation", async () => {
			const result = await analyzeWith({
				verification: unknownVerification,
				tokenSecurity: {
					is_honeypot: false,
					is_mintable: false,
					can_take_back_ownership: undefined,
					hidden_owner: undefined,
					selfdestruct: false,
					buy_tax: 0,
					sell_tax: 0,
					is_blacklisted: true,
					owner_can_change_balance: false,
				},
			});

			expect(result.findings.some((f) => f.code === "BLACKLIST")).toBe(true);
			expect(result.recommendation).toBe("warning");
		});

		test("owner can change balances → OWNER_DRAIN finding + danger recommendation", async () => {
			const result = await analyzeWith({
				verification: unknownVerification,
				tokenSecurity: {
					is_honeypot: false,
					is_mintable: false,
					can_take_back_ownership: undefined,
					hidden_owner: undefined,
					selfdestruct: false,
					buy_tax: 0,
					sell_tax: 0,
					is_blacklisted: false,
					owner_can_change_balance: true,
				},
			});

			expect(result.findings.some((f) => f.code === "OWNER_DRAIN")).toBe(true);
			expect(result.recommendation).toBe("danger");
		});

		test("high tax → HIGH_TAX finding + warning recommendation", async () => {
			const result = await analyzeWith({
				verification: unknownVerification,
				tokenSecurity: {
					is_honeypot: false,
					is_mintable: false,
					can_take_back_ownership: undefined,
					hidden_owner: undefined,
					selfdestruct: false,
					buy_tax: 0.15,
					sell_tax: 0,
					is_blacklisted: false,
					owner_can_change_balance: false,
				},
			});

			expect(result.findings.some((f) => f.code === "HIGH_TAX")).toBe(true);
			expect(result.recommendation).toBe("warning");
		});
	});
});
