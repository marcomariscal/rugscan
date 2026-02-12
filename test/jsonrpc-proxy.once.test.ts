import { describe, expect, test } from "bun:test";
import { createJsonRpcProxyServer, type ProxyScanOutcome } from "../src/jsonrpc/proxy";
import type { ScanInput } from "../src/schema";
import type { Chain, Config } from "../src/types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function makeUpstream(seen: unknown[]) {
	return Bun.serve({
		port: 0,
		fetch: async (request) => {
			const body: unknown = await request.json();
			seen.push(body);
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
}

const TX_PAYLOAD = {
	jsonrpc: "2.0",
	id: 10,
	method: "eth_sendTransaction",
	params: [
		{
			chainId: "0x1",
			from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
			to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
			value: "0x0",
			data: "0x",
		},
	],
};

async function waitForServerStop(url: string, timeoutMs = 1_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await fetch(url, { method: "GET" });
		} catch {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
}

describe("jsonrpc proxy --once semantics", () => {
	test("non-interceptable request does not trigger once shutdown", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = makeUpstream(upstreamSeen);
		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			once: true,
			exitOnOnce: false,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn: async (
				_input: ScanInput,
				_ctx: { chain: Chain; config: Config },
			): Promise<ProxyScanOutcome> => ({ recommendation: "ok", simulationSuccess: true }),
		});

		try {
			const payload1 = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
			const res1 = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload1),
			});
			expect(res1.status).toBe(200);

			const payload2 = { jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] };
			const res2 = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload2),
			});
			expect(res2.status).toBe(200);

			const chainIdCalls = upstreamSeen.filter(
				(entry) => isRecord(entry) && entry.method === "eth_chainId",
			);
			expect(chainIdCalls.length).toBe(2);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	});

	test("first interceptable send request triggers once shutdown", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = makeUpstream(upstreamSeen);
		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			once: true,
			exitOnOnce: false,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn: async (
				_input: ScanInput,
				_ctx: { chain: Chain; config: Config },
			): Promise<ProxyScanOutcome> => ({ recommendation: "ok", simulationSuccess: true }),
		});

		try {
			const txRes = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(TX_PAYLOAD),
			});
			expect(txRes.status).toBe(200);

			const parsed: unknown = await txRes.json();
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) return;
			expect(parsed.result).toBe("0xTX_OK");

			const stopped = await waitForServerStop(`http://127.0.0.1:${proxy.port}`);
			expect(stopped).toBe(true);

			const sendCalls = upstreamSeen.filter(
				(entry) => isRecord(entry) && entry.method === "eth_sendTransaction",
			);
			expect(sendCalls.length).toBe(1);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	});

	test("typed-data interception also triggers once shutdown", async () => {
		const upstreamSeen: unknown[] = [];
		const upstream = makeUpstream(upstreamSeen);
		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			once: true,
			exitOnOnce: false,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn: async (
				_input: ScanInput,
				_ctx: { chain: Chain; config: Config },
			): Promise<ProxyScanOutcome> => ({ recommendation: "ok", simulationSuccess: true }),
		});

		try {
			const typedDataPayload = {
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
			};
			const signRes = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 20,
					method: "eth_signTypedData_v4",
					params: ["0x24274566a1ad6a9b056e8e2618549ebd2f5141a7", JSON.stringify(typedDataPayload)],
				}),
			});
			expect(signRes.status).toBe(200);

			const stopped = await waitForServerStop(`http://127.0.0.1:${proxy.port}`);
			expect(stopped).toBe(true);
			expect(
				upstreamSeen.filter((entry) => isRecord(entry) && entry.method === "eth_signTypedData_v4")
					.length,
			).toBe(1);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	});
});
