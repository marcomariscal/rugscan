import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { createJsonRpcProxyServer } from "../src/jsonrpc/proxy";
import type { AnalyzeResponse, ScanInput } from "../src/schema";
import type { Chain, Config, Recommendation } from "../src/types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

describe("jsonrpc proxy - integration", () => {
	test("passes through non-sendTransaction methods", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
				upstreamSeen.push(body);
				const id = isRecord(body) && "id" in body ? body.id : null;
				return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x01" }), {
					headers: { "content-type": "application/json" },
				});
			},
		});

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn: async () => ({ recommendation: "ok", simulationSuccess: true }),
		});

		try {
			const payload = { jsonrpc: "2.0", id: 42, method: "eth_blockNumber", params: [] };
			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);
			const parsed: unknown = await res.json();
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) return;
			expect(parsed.jsonrpc).toBe("2.0");
			expect(parsed.id).toBe(42);
			expect(parsed.result).toBe("0x01");
			expect(upstreamSeen.length).toBe(1);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("intercepts eth_sendTransaction and blocks when dangerous", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
				upstreamSeen.push(body);
				if (isRecord(body) && body.method === "eth_chainId") {
					return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x1" }), {
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: isRecord(body) ? (body.id ?? 1) : 1,
						result: "0xTX",
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});

		const scanFn = async (
			_input: ScanInput,
			_ctx: { chain: Chain; config: Config },
		): Promise<{ recommendation: Recommendation; simulationSuccess: boolean }> => {
			return { recommendation: "danger", simulationSuccess: true };
		};

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn,
		});

		try {
			const tx = {
				to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
				from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
				data: "0x",
				value: "0x0",
			};
			const payload = { jsonrpc: "2.0", id: 1, method: "eth_sendTransaction", params: [tx] };

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);
			const parsed: unknown = await res.json();
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) return;
			expect(parsed.jsonrpc).toBe("2.0");
			expect(parsed.id).toBe(1);
			expect("error" in parsed).toBe(true);
			const err = parsed.error;
			expect(isRecord(err)).toBe(true);
			if (!isRecord(err)) return;
			expect(err.code).toBe(4001);
			// Upstream should only see chainId probe.
			expect(
				upstreamSeen.some((entry) => isRecord(entry) && entry.method === "eth_sendTransaction"),
			).toBe(false);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("intercepts eth_sendTransaction and forwards when ok+simulation success", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
				upstreamSeen.push(body);
				if (isRecord(body) && body.method === "eth_chainId") {
					return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x1" }), {
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: isRecord(body) ? (body.id ?? 1) : 1,
						result: "0xTX_OK",
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});

		const scanFn = async (
			_input: ScanInput,
			_ctx: { chain: Chain; config: Config },
		): Promise<{ recommendation: Recommendation; simulationSuccess: boolean }> => {
			return { recommendation: "ok", simulationSuccess: true };
		};

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn,
		});

		try {
			const tx = {
				to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
				from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
				data: "0x",
				value: "0x0",
			};
			const payload = { jsonrpc: "2.0", id: 2, method: "eth_sendTransaction", params: [tx] };

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);
			const parsed: unknown = await res.json();
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) return;
			expect(parsed.jsonrpc).toBe("2.0");
			expect(parsed.id).toBe(2);
			expect(parsed.result).toBe("0xTX_OK");
			expect(
				upstreamSeen.some((entry) => isRecord(entry) && entry.method === "eth_sendTransaction"),
			).toBe(true);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("blocks when tx target is not allowlisted", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
				upstreamSeen.push(body);
				if (isRecord(body) && body.method === "eth_chainId") {
					return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x1" }), {
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: isRecord(body) ? (body.id ?? 1) : 1,
						result: "0xTX",
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			policy: { threshold: "danger", onRisk: "block" },
			config: {
				allowlist: {
					to: ["0x0000000000000000000000000000000000000001"],
				},
			},
			scanFn: async () => ({ recommendation: "ok", simulationSuccess: true }),
		});

		try {
			const tx = {
				to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
				from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
				data: "0x",
				value: "0x0",
			};
			const payload = { jsonrpc: "2.0", id: 77, method: "eth_sendTransaction", params: [tx] };

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);
			const parsed: unknown = await res.json();
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) return;
			expect("error" in parsed).toBe(true);
			const err = parsed.error;
			expect(isRecord(err)).toBe(true);
			if (!isRecord(err)) return;
			expect(err.code).toBe(4001);
			expect(isRecord(err.data)).toBe(true);
			if (!isRecord(err.data)) return;
			expect(isRecord(err.data.allowlist)).toBe(true);
			if (!isRecord(err.data.allowlist)) return;
			expect(Array.isArray(err.data.allowlist.violations)).toBe(true);
			const violations = err.data.allowlist.violations;
			if (!Array.isArray(violations)) return;
			expect(violations.some((v) => isRecord(v) && v.kind === "target")).toBe(true);
			expect(
				upstreamSeen.some((entry) => isRecord(entry) && entry.method === "eth_sendTransaction"),
			).toBe(false);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("blocks when approval spender is not allowlisted (simulation approvals)", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
				upstreamSeen.push(body);
				if (isRecord(body) && body.method === "eth_chainId") {
					return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x1" }), {
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: isRecord(body) ? (body.id ?? 1) : 1,
						result: "0xTX",
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});

		const token = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";
		const owner = "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7";
		const spender = "0x1111111111111111111111111111111111111111";

		const response: AnalyzeResponse = {
			schemaVersion: 2,
			requestId: "00000000-0000-0000-0000-000000000000",
			scan: {
				input: {
					calldata: {
						to: token,
						from: owner,
						data: "0x",
						value: "0",
						chain: "1",
					},
				},
				recommendation: "ok",
				findings: [],
				contract: {
					address: token,
					chain: "ethereum",
					isContract: true,
					confidence: "high",
				},
				simulation: {
					status: "success",
					balances: {
						changes: [],
						confidence: "high",
					},
					approvals: {
						changes: [
							{
								standard: "erc20",
								token,
								owner,
								spender,
								amount: "1",
							},
						],
						confidence: "high",
					},
					notes: [],
				},
			},
		};

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			policy: { threshold: "danger", onRisk: "block" },
			config: {
				allowlist: {
					to: [token],
					spenders: ["0x2222222222222222222222222222222222222222"],
				},
			},
			scanFn: async () => ({
				recommendation: "ok",
				simulationSuccess: true,
				response,
			}),
		});

		try {
			const tx = {
				to: token,
				from: owner,
				data: "0x",
				value: "0x0",
			};
			const payload = { jsonrpc: "2.0", id: 78, method: "eth_sendTransaction", params: [tx] };

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);
			const parsed: unknown = await res.json();
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) return;
			expect("error" in parsed).toBe(true);
			const err = parsed.error;
			expect(isRecord(err)).toBe(true);
			if (!isRecord(err)) return;
			expect(err.code).toBe(4001);
			expect(isRecord(err.data)).toBe(true);
			if (!isRecord(err.data)) return;
			expect(err.data.recommendation).toBe("warning");
			expect(isRecord(err.data.allowlist)).toBe(true);
			if (!isRecord(err.data.allowlist)) return;
			expect(Array.isArray(err.data.allowlist.violations)).toBe(true);
			const violations = err.data.allowlist.violations;
			if (!Array.isArray(violations)) return;
			expect(
				violations.some(
					(v) =>
						isRecord(v) &&
						v.kind === "approvalSpender" &&
						typeof v.address === "string" &&
						v.address.toLowerCase() === spender.toLowerCase(),
				),
			).toBe(true);
			expect(
				upstreamSeen.some((entry) => isRecord(entry) && entry.method === "eth_sendTransaction"),
			).toBe(false);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("blocks when approval spender is not allowlisted (decoded calldata finding)", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
				upstreamSeen.push(body);
				if (isRecord(body) && body.method === "eth_chainId") {
					return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x1" }), {
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: isRecord(body) ? (body.id ?? 1) : 1,
						result: "0xTX",
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});

		const token = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";
		const owner = "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7";
		const spender = "0x3333333333333333333333333333333333333333";

		const response: AnalyzeResponse = {
			schemaVersion: 2,
			requestId: "00000000-0000-0000-0000-000000000000",
			scan: {
				input: {
					calldata: {
						to: token,
						from: owner,
						data: "0x",
						value: "0",
						chain: "1",
					},
				},
				recommendation: "ok",
				findings: [
					{
						code: "CALLDATA_DECODED",
						severity: "ok",
						message: "Decoded calldata",
						details: {
							args: { spender, amount: "1" },
							argNames: ["spender", "amount"],
						},
					},
				],
				contract: {
					address: token,
					chain: "ethereum",
					isContract: true,
					confidence: "high",
				},
				simulation: {
					status: "success",
					balances: {
						changes: [],
						confidence: "high",
					},
					approvals: {
						changes: [],
						confidence: "high",
					},
					notes: [],
				},
			},
		};

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			policy: { threshold: "danger", onRisk: "block" },
			config: {
				allowlist: {
					to: [token],
					spenders: ["0x4444444444444444444444444444444444444444"],
				},
			},
			scanFn: async () => ({
				recommendation: "ok",
				simulationSuccess: true,
				response,
			}),
		});

		try {
			const tx = {
				to: token,
				from: owner,
				data: "0x",
				value: "0x0",
			};
			const payload = { jsonrpc: "2.0", id: 79, method: "eth_sendTransaction", params: [tx] };

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);
			const parsed: unknown = await res.json();
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) return;
			expect("error" in parsed).toBe(true);
			const err = parsed.error;
			expect(isRecord(err)).toBe(true);
			if (!isRecord(err)) return;
			expect(err.code).toBe(4001);
			expect(isRecord(err.data)).toBe(true);
			if (!isRecord(err.data)) return;
			expect(isRecord(err.data.allowlist)).toBe(true);
			if (!isRecord(err.data.allowlist)) return;
			expect(Array.isArray(err.data.allowlist.violations)).toBe(true);
			const violations = err.data.allowlist.violations;
			if (!Array.isArray(violations)) return;
			expect(
				violations.some(
					(v) =>
						isRecord(v) &&
						v.kind === "approvalSpender" &&
						v.source === "calldata" &&
						typeof v.address === "string" &&
						v.address.toLowerCase() === spender.toLowerCase(),
				),
			).toBe(true);
			expect(
				upstreamSeen.some((entry) => isRecord(entry) && entry.method === "eth_sendTransaction"),
			).toBe(false);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("does not respond to notifications (no id)", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
				upstreamSeen.push(body);
				if (isRecord(body) && body.method === "eth_chainId") {
					return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x1" }), {
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: isRecord(body) ? (body.id ?? 1) : 1,
						result: "0xOK",
					}),
					{
						headers: { "content-type": "application/json" },
					},
				);
			},
		});

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn: async () => ({ recommendation: "ok", simulationSuccess: true }),
		});

		try {
			const tx = {
				to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
				from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
				data: "0x",
				value: "0x0",
			};
			const payload = { jsonrpc: "2.0", method: "eth_sendTransaction", params: [tx] };

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(204);
			expect(
				upstreamSeen.some((entry) => isRecord(entry) && entry.method === "eth_sendTransaction"),
			).toBe(true);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("intercepts eth_sendRawTransaction and forwards when ok+simulation success", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
				upstreamSeen.push(body);
				if (isRecord(body) && body.method === "eth_chainId") {
					return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x1" }), {
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: isRecord(body) ? (body.id ?? 1) : 1,
						result: "0xRAW_OK",
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});

		const seenInputs: ScanInput[] = [];
		const scanFn = async (
			input: ScanInput,
			_ctx: { chain: Chain; config: Config },
		): Promise<{ recommendation: Recommendation; simulationSuccess: boolean }> => {
			seenInputs.push(input);
			return { recommendation: "ok", simulationSuccess: true };
		};

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn,
		});

		try {
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
			const payload = { jsonrpc: "2.0", id: 9, method: "eth_sendRawTransaction", params: [signed] };

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);
			const parsed: unknown = await res.json();
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) return;
			expect(parsed.result).toBe("0xRAW_OK");
			expect(
				upstreamSeen.some((entry) => isRecord(entry) && entry.method === "eth_sendRawTransaction"),
			).toBe(true);
			expect(seenInputs.length).toBe(1);
			const input = seenInputs[0];
			expect(isRecord(input.calldata)).toBe(true);
			if (!isRecord(input.calldata)) return;
			expect(input.calldata.to).toBe("0x66a9893cc07d91d95644aedd05d03f95e1dba8af");
			expect(input.calldata.chain).toBe("1");
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("intercepts eth_signTypedData_v4 permit signatures and blocks risky payloads", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
				upstreamSeen.push(body);
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: isRecord(body) ? (body.id ?? 1) : 1,
						result: "0xSIG",
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn: async () => ({ recommendation: "ok", simulationSuccess: true }),
		});

		try {
			const typedData = {
				types: {
					EIP712Domain: [{ name: "name", type: "string" }],
					PermitSingle: [
						{ name: "details", type: "PermitDetails" },
						{ name: "spender", type: "address" },
						{ name: "sigDeadline", type: "uint256" },
					],
					PermitDetails: [
						{ name: "token", type: "address" },
						{ name: "amount", type: "uint160" },
						{ name: "expiration", type: "uint48" },
						{ name: "nonce", type: "uint48" },
					],
				},
				primaryType: "PermitSingle",
				domain: { chainId: 1 },
				message: {
					details: {
						token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
						amount: "1461501637330902918203684832716283019655932542975",
						expiration: "0",
						nonce: "5",
					},
					spender: "0x9999999999999999999999999999999999999999",
					sigDeadline: "0",
				},
			};
			const payload = {
				jsonrpc: "2.0",
				id: 501,
				method: "eth_signTypedData_v4",
				params: ["0x24274566a1ad6a9b056e8e2618549ebd2f5141a7", JSON.stringify(typedData)],
			};

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);
			const parsed: unknown = await res.json();
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) return;
			expect("error" in parsed).toBe(true);
			const err = parsed.error;
			expect(isRecord(err)).toBe(true);
			if (!isRecord(err)) return;
			expect(err.code).toBe(4001);
			expect(isRecord(err.data)).toBe(true);
			if (!isRecord(err.data)) return;
			expect(isRecord(err.data.typedData)).toBe(true);
			if (!isRecord(err.data.typedData)) return;
			expect(Array.isArray(err.data.typedData.findings)).toBe(true);
			const findings = err.data.typedData.findings;
			expect(
				Array.isArray(findings) &&
					findings.some(
						(item) =>
							isRecord(item) && item.code === "PERMIT_SIGNATURE" && item.severity === "caution",
					),
			).toBe(true);
			expect(
				Array.isArray(findings) &&
					findings.some((item) => isRecord(item) && item.code === "PERMIT_UNLIMITED_ALLOWANCE"),
			).toBe(true);
			expect(Array.isArray(err.data.typedData.actionableNotes)).toBe(true);
			const notes = err.data.typedData.actionableNotes;
			expect(
				Array.isArray(notes) &&
					notes.some((note) => typeof note === "string" && note.includes("Only sign if you trust")),
			).toBe(true);
			expect(
				upstreamSeen.some((entry) => isRecord(entry) && entry.method === "eth_signTypedData_v4"),
			).toBe(false);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("forwards non-permit eth_signTypedData_v4 payloads", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
				upstreamSeen.push(body);
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: isRecord(body) ? (body.id ?? 1) : 1,
						result: "0xFORWARDED_SIG",
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn: async () => ({ recommendation: "ok", simulationSuccess: true }),
		});

		try {
			const payload = {
				jsonrpc: "2.0",
				id: 502,
				method: "eth_signTypedData_v4",
				params: [
					"0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
					JSON.stringify({
						types: {
							EIP712Domain: [{ name: "name", type: "string" }],
							Mail: [
								{ name: "from", type: "address" },
								{ name: "contents", type: "string" },
							],
						},
						primaryType: "Mail",
						domain: { chainId: 1 },
						message: {
							from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
							contents: "hello",
						},
					}),
				],
			};

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);
			const parsed: unknown = await res.json();
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) return;
			expect(parsed.result).toBe("0xFORWARDED_SIG");
			expect(
				upstreamSeen.some((entry) => isRecord(entry) && entry.method === "eth_signTypedData_v4"),
			).toBe(true);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("handles JSON-RPC batches and forwards sendTransaction per-entry", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
				upstreamSeen.push(body);
				const id = isRecord(body) && "id" in body ? (body.id ?? 1) : 1;
				if (isRecord(body) && body.method === "eth_chainId") {
					return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }), {
						headers: { "content-type": "application/json" },
					});
				}
				if (isRecord(body) && body.method === "eth_blockNumber") {
					return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0xBEEF" }), {
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0xTX_BATCH" }), {
					headers: { "content-type": "application/json" },
				});
			},
		});

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn: async () => ({ recommendation: "ok", simulationSuccess: true }),
		});

		try {
			const tx = {
				to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
				from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
				data: "0x",
				value: "0x0",
			};
			const batch = [
				{ jsonrpc: "2.0", id: 10, method: "eth_blockNumber", params: [] },
				{ jsonrpc: "2.0", id: 11, method: "eth_sendTransaction", params: [tx] },
				{ jsonrpc: "2.0", method: "eth_blockNumber", params: [] },
			];

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(batch),
			});
			expect(res.status).toBe(200);
			const parsed: unknown = await res.json();
			expect(Array.isArray(parsed)).toBe(true);
			if (!Array.isArray(parsed)) return;
			expect(parsed.length).toBe(2);

			const ids = parsed
				.filter(isRecord)
				.map((entry) => entry.id)
				.sort();
			expect(ids).toEqual([10, 11]);

			expect(upstreamSeen.some(Array.isArray)).toBe(false);
			expect(
				upstreamSeen.filter((entry) => isRecord(entry) && entry.method === "eth_sendTransaction")
					.length,
			).toBe(1);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);
});
