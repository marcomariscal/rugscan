import { describe, expect, test } from "bun:test";
import type { ScanInput } from "../src/schema";
import { applySimulationVerdict } from "../src/simulations/verdict";
import type { AnalysisResult, BalanceSimulationResult } from "../src/types";

const MAX_UINT256 = (1n << 256n) - 1n;

function baseAnalysis(): AnalysisResult {
	return {
		contract: {
			address: "0x1111111111111111111111111111111111111111",
			chain: "ethereum",
			verified: true,
			is_proxy: false,
		},
		findings: [
			{
				level: "safe",
				code: "VERIFIED",
				message: "Source code verified",
			},
		],
		confidence: { level: "high", reasons: [] },
		recommendation: "ok",
	};
}

function calldataInput(): ScanInput {
	return {
		calldata: {
			to: "0x2222222222222222222222222222222222222222",
			from: "0x3333333333333333333333333333333333333333",
			data: "0xdeadbeef",
			chain: "1",
		},
	};
}

function withSimulation(
	analysis: AnalysisResult,
	simulation: BalanceSimulationResult,
): AnalysisResult {
	return { ...analysis, simulation };
}

describe("simulation-driven drainer heuristics", () => {
	test("bumps risk for unlimited ERC20 approval to an unknown spender", () => {
		const analysis = withSimulation(baseAnalysis(), {
			success: true,
			assetChanges: [],
			approvals: [
				{
					standard: "erc20",
					token: "0x4444444444444444444444444444444444444444",
					owner: "0x3333333333333333333333333333333333333333",
					spender: "0x9999999999999999999999999999999999999999",
					amount: MAX_UINT256,
				},
			],
			confidence: "high",
			notes: [],
		});

		const result = applySimulationVerdict(calldataInput(), analysis);
		expect(result.findings.some((f) => f.code === "SIM_UNLIMITED_APPROVAL_UNKNOWN_SPENDER")).toBe(
			true,
		);
		expect(result.recommendation).not.toBe("ok");
	});

	test("bumps risk for ApprovalForAll granted to an unknown operator", () => {
		const analysis = withSimulation(baseAnalysis(), {
			success: true,
			assetChanges: [],
			approvals: [
				{
					standard: "erc721",
					token: "0x5555555555555555555555555555555555555555",
					owner: "0x3333333333333333333333333333333333333333",
					spender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					scope: "all",
					approved: true,
				},
			],
			confidence: "high",
			notes: [],
		});

		const result = applySimulationVerdict(calldataInput(), analysis);
		expect(result.findings.some((f) => f.code === "SIM_APPROVAL_FOR_ALL_UNKNOWN_OPERATOR")).toBe(
			true,
		);
		expect(result.recommendation).toBe("danger");
	});

	test("bumps risk for multiple outbound transfers to unknown counterparties", () => {
		const analysis = withSimulation(baseAnalysis(), {
			success: true,
			assetChanges: [
				{
					assetType: "erc721",
					address: "0x7777777777777777777777777777777777777777",
					tokenId: 1n,
					direction: "out",
					counterparty: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				},
				{
					assetType: "erc721",
					address: "0x7777777777777777777777777777777777777777",
					tokenId: 2n,
					direction: "out",
					counterparty: "0xcccccccccccccccccccccccccccccccccccccccc",
				},
			],
			approvals: [],
			confidence: "high",
			notes: [],
		});

		const result = applySimulationVerdict(calldataInput(), analysis);
		expect(result.findings.some((f) => f.code === "SIM_MULTIPLE_OUTBOUND_TRANSFERS")).toBe(true);
		expect(result.recommendation).toBe("danger");
	});

	test("does not flag a typical swap-style simulation", () => {
		const uniswapV2Router = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
		const analysis = withSimulation(baseAnalysis(), {
			success: true,
			assetChanges: [
				{
					assetType: "erc20",
					address: "0x4444444444444444444444444444444444444444",
					amount: 1000n,
					direction: "out",
				},
				{
					assetType: "erc20",
					address: "0x8888888888888888888888888888888888888888",
					amount: 900n,
					direction: "in",
				},
			],
			approvals: [
				{
					standard: "erc20",
					token: "0x4444444444444444444444444444444444444444",
					owner: "0x3333333333333333333333333333333333333333",
					spender: uniswapV2Router,
					amount: MAX_UINT256,
				},
			],
			confidence: "high",
			notes: [],
		});

		const result = applySimulationVerdict(calldataInput(), analysis);
		const codes = new Set(result.findings.map((finding) => finding.code));
		expect(codes.has("SIM_UNLIMITED_APPROVAL_UNKNOWN_SPENDER")).toBe(false);
		expect(codes.has("SIM_APPROVAL_FOR_ALL_UNKNOWN_OPERATOR")).toBe(false);
		expect(codes.has("SIM_MULTIPLE_OUTBOUND_TRANSFERS")).toBe(false);
		expect(result.recommendation).toBe("ok");
	});
});
