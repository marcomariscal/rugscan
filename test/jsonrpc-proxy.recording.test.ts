import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJsonRpcProxyServer } from "../src/jsonrpc/proxy";
import type { ScanInput } from "../src/schema";
import type { Chain, Config, Recommendation } from "../src/types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

describe("jsonrpc proxy - recording", () => {
	test("writes a recording bundle when recordDir is set", async () => {
		const recordDir = path.join(os.tmpdir(), `rugscan-proxy-record-${Date.now()}`);

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
			input: ScanInput,
			_ctx: { chain: Chain; config: Config },
		): Promise<{
			recommendation: Recommendation;
			simulationSuccess: boolean;
			response: unknown;
		}> => {
			return {
				recommendation: "ok",
				simulationSuccess: true,
				response: {
					requestId: crypto.randomUUID(),
					scan: {
						input,
						recommendation: "ok",
						confidence: 1,
						findings: [],
						contract: {
							address: input.calldata?.to ?? "0x0000000000000000000000000000000000000000",
							chain: "ethereum",
							isContract: true,
							isProxy: false,
							verifiedSource: false,
						},
					},
				},
			};
		};

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			recordDir,
			policy: { threshold: "danger", onRisk: "block" },
			scanFn: scanFn as never,
		});

		try {
			const payload = {
				jsonrpc: "2.0",
				id: 1,
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

			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);

			const bundles = await readdir(recordDir);
			expect(bundles.length).toBe(1);
			const files = await readdir(path.join(recordDir, bundles[0] ?? ""));
			const set = new Set(files);
			expect(set.has("meta.json")).toBe(true);
			expect(set.has("rpc.json")).toBe(true);
			expect(set.has("calldata.json")).toBe(true);
			expect(set.has("analyzeResponse.json")).toBe(true);

			expect(upstreamSeen.length > 0).toBe(true);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	});
});
