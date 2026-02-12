import { describe, expect, test } from "bun:test";
import { createJsonRpcProxyServer, type ProxyScanOutcome } from "../src/jsonrpc/proxy";
import type { ScanInput } from "../src/schema";
import type { Chain, Config } from "../src/types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

describe("jsonrpc proxy - block feedback", () => {
	test("prints 'Blocked transaction.' when not quiet", async () => {
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
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

		const writes: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			if (typeof chunk === "string") {
				writes.push(chunk);
			}
			return true;
		}) as typeof process.stdout.write;

		const scanFn = async (
			_input: ScanInput,
			_ctx: { chain: Chain; config: Config },
		): Promise<ProxyScanOutcome> => {
			return { recommendation: "danger", simulationSuccess: true };
		};

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			// NOT quiet — we want to see the feedback
			quiet: false,
			once: true,
			exitOnOnce: false,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn,
		});

		try {
			const payload = {
				jsonrpc: "2.0",
				id: 1,
				method: "eth_sendTransaction",
				params: [
					{
						to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
						from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
						data: "0x",
						value: "0x0",
					},
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
			if (isRecord(parsed)) {
				expect("error" in parsed).toBe(true);
			}

			// Verify that the block feedback was printed to stdout
			const allOutput = writes.join("");
			expect(allOutput).toContain("Blocked transaction.");
		} finally {
			process.stdout.write = originalWrite;
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("does not print block feedback when quiet", async () => {
		const upstream = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body: unknown = await request.json();
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

		const writes: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			if (typeof chunk === "string") {
				writes.push(chunk);
			}
			return true;
		}) as typeof process.stdout.write;

		const scanFn = async (
			_input: ScanInput,
			_ctx: { chain: Chain; config: Config },
		): Promise<ProxyScanOutcome> => {
			return { recommendation: "danger", simulationSuccess: true };
		};

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			once: true,
			exitOnOnce: false,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn,
		});

		try {
			const payload = {
				jsonrpc: "2.0",
				id: 1,
				method: "eth_sendTransaction",
				params: [
					{
						to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
						from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
						data: "0x",
						value: "0x0",
					},
				],
			};

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);

			const allOutput = writes.join("");
			expect(allOutput).not.toContain("Transaction blocked");
		} finally {
			process.stdout.write = originalWrite;
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);
});
