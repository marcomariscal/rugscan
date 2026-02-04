import { describe, expect, test } from "bun:test";
import { createJsonRpcProxyServer } from "../src/jsonrpc/proxy";
import type { ScanInput } from "../src/schema";
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
