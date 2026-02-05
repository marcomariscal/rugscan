import { describe, expect, test } from "bun:test";
import { type AnalyzerDeps, analyze } from "../src/analyzer";
import { scanWithAnalysis } from "../src/scan";

function createStubDeps(calls: {
	rpc: number;
	proxy: number;
	sourcify: number;
	labels: number;
	etherscan: number;
	defillama: number;
	goplus: number;
	ai: number;
}): AnalyzerDeps {
	return {
		ai: {
			analyzeRisk: async () => {
				calls.ai += 1;
				return {
					analysis: {
						risk_score: 0,
						summary: "stub",
						concerns: [],
						model: "stub",
						provider: "openai",
					},
				};
			},
		},
		defillama: {
			matchProtocol: async () => {
				calls.defillama += 1;
				return null;
			},
		},
		etherscan: {
			getAddressLabels: async () => {
				calls.labels += 1;
				return null;
			},
			getContractData: async () => {
				calls.etherscan += 1;
				return null;
			},
		},
		goplus: {
			getTokenSecurity: async () => {
				calls.goplus += 1;
				return { data: null };
			},
		},
		proxy: {
			isContract: async () => {
				calls.rpc += 1;
				return true;
			},
			detectProxy: async () => {
				calls.proxy += 1;
				return { is_proxy: false };
			},
		},
		sourcify: {
			checkVerification: async () => {
				calls.sourcify += 1;
				return { verified: false };
			},
		},
	};
}

describe("analyzer wallet mode (unit)", () => {
	test("skips Etherscan Labels in wallet mode", async () => {
		const calls = {
			rpc: 0,
			proxy: 0,
			sourcify: 0,
			labels: 0,
			etherscan: 0,
			defillama: 0,
			goplus: 0,
			ai: 0,
		};
		const deps = createStubDeps(calls);
		const progressEvents: Array<{ provider: string; status: string; message?: string }> = [];

		await analyze(
			"0x0000000000000000000000000000000000000001",
			"ethereum",
			undefined,
			(event) => {
				progressEvents.push(event);
			},
			{ mode: "wallet", deps },
		);

		expect(calls.labels).toBe(0);
		expect(
			progressEvents.some(
				(e) => e.provider === "Etherscan Labels" && e.message?.includes("--wallet"),
			),
		).toBe(true);
	});

	test("wallet mode scan still runs simulation", async () => {
		const calls = {
			rpc: 0,
			proxy: 0,
			sourcify: 0,
			labels: 0,
			etherscan: 0,
			defillama: 0,
			goplus: 0,
			ai: 0,
		};
		const deps = createStubDeps(calls);

		const { analysis } = await scanWithAnalysis(
			{
				calldata: {
					to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
					from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
					data: "0x",
					value: "0",
					chain: "1",
				},
			},
			{
				chain: "ethereum",
				config: { simulation: { backend: "heuristic" } },
				analyzeOptions: { mode: "wallet", deps },
			},
		);

		expect(analysis.simulation).toBeDefined();
		expect(analysis.simulation?.notes.join("\n")).toContain("Heuristic-only simulation");
	});
});
