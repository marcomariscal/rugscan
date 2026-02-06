import { describe, expect, test } from "bun:test";
import { createTransport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { buildAnalyzeResponse } from "../src/scan";
import type { ScanInput } from "../src/schema";
import {
	createRugscanViemTransport,
	type RugscanScanFn,
	RugscanTransportError,
} from "../src/sdk/viem";
import type { AnalysisResult, BalanceSimulationResult, Config, Recommendation } from "../src/types";

function buildSimulation(success: boolean): BalanceSimulationResult {
	return {
		success,
		revertReason: success ? undefined : "Simulation not run",
		assetChanges: [],
		approvals: [],
		confidence: success ? "high" : "low",
		notes: success ? [] : ["Simulation not run"],
	};
}

function buildAnalysis(overrides: {
	recommendation: Recommendation;
	simulationSuccess: boolean;
}): AnalysisResult {
	return {
		contract: {
			address: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
			chain: "ethereum",
			verified: true,
			is_proxy: false,
		},
		findings: [],
		confidence: { level: "high", reasons: [] },
		recommendation: overrides.recommendation,
		simulation: buildSimulation(overrides.simulationSuccess),
	};
}

function createUpstream() {
	const calls: { method: string; params: unknown }[] = [];
	const transport = () =>
		createTransport({
			key: "upstream",
			name: "Upstream",
			type: "custom",
			async request({ method, params }) {
				calls.push({ method, params });
				return "0xdeadbeef";
			},
		});

	return { transport, calls };
}

describe("viem transport - unit", () => {
	test("blocks when simulation fails", async () => {
		const { transport: upstream, calls } = createUpstream();
		const config: Config = {};

		const scanFn: RugscanScanFn = async (input: ScanInput, options) => {
			const analysis = buildAnalysis({ recommendation: "ok", simulationSuccess: false });
			const response = buildAnalyzeResponse(input, analysis, options?.requestId);
			return { analysis, response };
		};

		const transport = createRugscanViemTransport({
			upstream,
			config,
			threshold: "danger",
			scanFn,
		});
		const client = transport({ chain: mainnet });

		let error: unknown;
		try {
			await client.request(
				{
					method: "eth_sendTransaction",
					params: [
						{
							to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
							from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
							data: "0x",
							value: "0x0",
							chainId: "0x1",
						},
					],
				},
				{ uid: "req-1" },
			);
		} catch (err) {
			error = err;
		}

		expect(calls.length).toBe(0);
		expect(error).toBeInstanceOf(RugscanTransportError);
		if (!(error instanceof RugscanTransportError)) return;
		expect(error.reason).toBe("simulation_failed");
		expect(error.analyzeResponse?.requestId).toBe("req-1");
		expect(typeof error.renderedSummary).toBe("string");
	});

	test("blocks when recommendation >= threshold", async () => {
		const { transport: upstream, calls } = createUpstream();
		const config: Config = {};

		const scanFn: RugscanScanFn = async (input: ScanInput, options) => {
			const analysis = buildAnalysis({ recommendation: "warning", simulationSuccess: true });
			const response = buildAnalyzeResponse(input, analysis, options?.requestId);
			return { analysis, response };
		};

		const transport = createRugscanViemTransport({
			upstream,
			config,
			threshold: "warning",
			scanFn,
		});
		const client = transport({ chain: mainnet });

		await expect(
			client.request({
				method: "eth_sendTransaction",
				params: [
					{
						to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
						from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
						data: "0x",
						value: "0x0",
						chainId: "0x1",
					},
				],
			}),
		).rejects.toBeInstanceOf(RugscanTransportError);

		expect(calls.length).toBe(0);
	});

	test("forwards when safe", async () => {
		const { transport: upstream, calls } = createUpstream();
		const config: Config = {};

		const scanFn: RugscanScanFn = async (input: ScanInput, options) => {
			const analysis = buildAnalysis({ recommendation: "ok", simulationSuccess: true });
			const response = buildAnalyzeResponse(input, analysis, options?.requestId);
			return { analysis, response };
		};

		const transport = createRugscanViemTransport({
			upstream,
			config,
			threshold: "warning",
			scanFn,
		});
		const client = transport({ chain: mainnet });

		const result = await client.request({
			method: "eth_sendTransaction",
			params: [
				{
					to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
					from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
					data: "0x",
					value: "0x0",
					chainId: "0x1",
				},
			],
		});

		expect(result).toBe("0xdeadbeef");
		expect(calls.length).toBe(1);
		expect(calls[0]?.method).toBe("eth_sendTransaction");
	});

	test("does not forward on analysis error", async () => {
		const { transport: upstream, calls } = createUpstream();
		const config: Config = {};

		const scanFn: RugscanScanFn = async () => {
			throw new Error("boom");
		};

		const transport = createRugscanViemTransport({
			upstream,
			config,
			threshold: "warning",
			scanFn,
		});
		const client = transport({ chain: mainnet });

		await expect(
			client.request({
				method: "eth_sendTransaction",
				params: [
					{
						to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
						from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
						data: "0x",
						value: "0x0",
						chainId: "0x1",
					},
				],
			}),
		).rejects.toBeInstanceOf(RugscanTransportError);

		expect(calls.length).toBe(0);
	});

	test("supports eth_sendRawTransaction path", async () => {
		const { transport: upstream, calls } = createUpstream();
		const config: Config = {};

		const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
		const signed = await account.signTransaction({
			chainId: 1,
			type: "eip1559",
			to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
			value: 123n,
			data: "0x1234",
			nonce: 0,
			gas: 21000n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
		});

		const scanFn: RugscanScanFn = async (input: ScanInput, options) => {
			expect(input.calldata?.to.toLowerCase()).toBe("0x66a9893cc07d91d95644aedd05d03f95e1dba8af");
			expect(input.calldata?.from?.toLowerCase()).toBe(account.address.toLowerCase());
			expect(input.calldata?.data).toBe("0x1234");
			expect(input.calldata?.value).toBe("123");
			expect(input.calldata?.chain).toBe("1");

			const analysis = buildAnalysis({ recommendation: "ok", simulationSuccess: true });
			const response = buildAnalyzeResponse(input, analysis, options?.requestId);
			return { analysis, response };
		};

		const transport = createRugscanViemTransport({
			upstream,
			config,
			threshold: "warning",
			scanFn,
		});
		const client = transport({ chain: mainnet });

		const result = await client.request({
			method: "eth_sendRawTransaction",
			params: [signed],
		});

		expect(result).toBe("0xdeadbeef");
		expect(calls.length).toBe(1);
		expect(calls[0]?.method).toBe("eth_sendRawTransaction");
	});
});
