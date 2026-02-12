import { describe, expect, test } from "bun:test";
import { createTransport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { buildAnalyzeResponse } from "../src/scan";
import type { ScanInput } from "../src/schema";
import { type AssayScanFn, AssayTransportError, createAssayViemTransport } from "../src/sdk/viem";
import type { AnalysisResult, BalanceSimulationResult, Config, Recommendation } from "../src/types";

function buildSimulation(success: boolean): BalanceSimulationResult {
	return {
		success,
		revertReason: success ? undefined : "Simulation not run",
		balances: {
			changes: [],
			confidence: success ? "high" : "low",
		},
		approvals: {
			changes: [],
			confidence: success ? "high" : "low",
		},
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
			confidence: "high",
			is_proxy: false,
		},
		findings: [],
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

		const scanFn: AssayScanFn = async (input: ScanInput, options) => {
			const analysis = buildAnalysis({ recommendation: "ok", simulationSuccess: false });
			const response = buildAnalyzeResponse(input, analysis, options?.requestId);
			return { analysis, response };
		};

		const transport = createAssayViemTransport({
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
		expect(error).toBeInstanceOf(AssayTransportError);
		if (!(error instanceof AssayTransportError)) return;
		expect(error.reason).toBe("simulation_failed");
		expect(error.analyzeResponse?.requestId).toBe("req-1");
		expect(typeof error.renderedSummary).toBe("string");
	});

	test("blocks when recommendation >= threshold", async () => {
		const { transport: upstream, calls } = createUpstream();
		const config: Config = {};

		const scanFn: AssayScanFn = async (input: ScanInput, options) => {
			const analysis = buildAnalysis({ recommendation: "warning", simulationSuccess: true });
			const response = buildAnalyzeResponse(input, analysis, options?.requestId);
			return { analysis, response };
		};

		const transport = createAssayViemTransport({
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
		).rejects.toBeInstanceOf(AssayTransportError);

		expect(calls.length).toBe(0);
	});

	test("forwards when safe", async () => {
		const { transport: upstream, calls } = createUpstream();
		const config: Config = {};

		const scanFn: AssayScanFn = async (input: ScanInput, options) => {
			const analysis = buildAnalysis({ recommendation: "ok", simulationSuccess: true });
			const response = buildAnalyzeResponse(input, analysis, options?.requestId);
			return { analysis, response };
		};

		const transport = createAssayViemTransport({
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

		const scanFn: AssayScanFn = async () => {
			throw new Error("boom");
		};

		const transport = createAssayViemTransport({
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
		).rejects.toBeInstanceOf(AssayTransportError);

		expect(calls.length).toBe(0);
	});

	test("preserves authorizationList for eth_sendTransaction payloads", async () => {
		const { transport: upstream, calls } = createUpstream();
		const config: Config = {};

		const scanFn: AssayScanFn = async (input: ScanInput, options) => {
			expect(input.calldata?.authorizationList).toHaveLength(1);
			expect(input.calldata?.authorizationList?.[0]?.address.toLowerCase()).toBe(
				"0x1234567890abcdef1234567890abcdef12345678",
			);
			expect(input.calldata?.authorizationList?.[0]?.chainId).toBe(1);
			expect(input.calldata?.authorizationList?.[0]?.nonce).toBe(7);

			const analysis = buildAnalysis({ recommendation: "ok", simulationSuccess: true });
			const response = buildAnalyzeResponse(input, analysis, options?.requestId);
			return { analysis, response };
		};

		const transport = createAssayViemTransport({
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
					authorizationList: [
						{
							address: "0x1234567890abcdef1234567890abcdef12345678",
							chainId: "0x1",
							nonce: "0x7",
						},
					],
				},
			],
		});

		expect(result).toBe("0xdeadbeef");
		expect(calls.length).toBe(1);
		expect(calls[0]?.method).toBe("eth_sendTransaction");
	});

	test("supports eth_sendRawTransaction path (type-4 eip7702)", async () => {
		const { transport: upstream, calls } = createUpstream();
		const config: Config = {};

		const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
		const signedAuthorization = await account.signAuthorization({
			chainId: 1,
			nonce: 7,
			address: "0x1234567890abcdef1234567890abcdef12345678",
		});
		const signed = await account.signTransaction({
			chainId: 1,
			type: "eip7702",
			to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
			value: 123n,
			data: "0x1234",
			nonce: 0,
			gas: 21000n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			authorizationList: [signedAuthorization],
		});

		const scanFn: AssayScanFn = async (input: ScanInput, options) => {
			expect(input.calldata?.to.toLowerCase()).toBe("0x66a9893cc07d91d95644aedd05d03f95e1dba8af");
			expect(input.calldata?.from?.toLowerCase()).toBe(account.address.toLowerCase());
			expect(input.calldata?.data).toBe("0x1234");
			expect(input.calldata?.value).toBe("123");
			expect(input.calldata?.chain).toBe("1");
			expect(input.calldata?.authorizationList).toHaveLength(1);
			expect(input.calldata?.authorizationList?.[0]?.address.toLowerCase()).toBe(
				"0x1234567890abcdef1234567890abcdef12345678",
			);
			expect(input.calldata?.authorizationList?.[0]?.chainId).toBe(1);
			expect(input.calldata?.authorizationList?.[0]?.nonce).toBe(7);

			const analysis = buildAnalysis({ recommendation: "ok", simulationSuccess: true });
			const response = buildAnalyzeResponse(input, analysis, options?.requestId);
			return { analysis, response };
		};

		const transport = createAssayViemTransport({
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
