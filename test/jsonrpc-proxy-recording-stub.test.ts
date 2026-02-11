import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJsonRpcProxyServer, type ProxyScanOutcome } from "../src/jsonrpc/proxy";
import type { ScanInput } from "../src/schema";
import type { Chain, Config } from "../src/types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

describe("jsonrpc proxy - recording stub", () => {
	test("persists a recording even when scan throws", async () => {
		const recordDir = path.join(os.tmpdir(), `assay-proxy-stub-${Date.now()}`);

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

		const scanFn = async (
			_input: ScanInput,
			_ctx: { chain: Chain; config: Config },
		): Promise<ProxyScanOutcome> => {
			throw new Error("simulated scan crash");
		};

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			recordDir,
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
			// Should still return a response (blocked due to scan failure)
			expect(res.status).toBe(200);

			// Recording should exist with at least the stub files
			const bundles = await readdir(recordDir);
			expect(bundles.length).toBe(1);
			const bundleDir = path.join(recordDir, bundles[0] ?? "");
			const files = new Set(await readdir(bundleDir));

			// Stub files must always be present
			expect(files.has("rpc.json")).toBe(true);
			expect(files.has("calldata.json")).toBe(true);
			expect(files.has("meta.json")).toBe(true);

			// Meta should have been enriched to "complete" even on error path
			const meta = JSON.parse(await readFile(path.join(bundleDir, "meta.json"), "utf-8"));
			expect(isRecord(meta)).toBe(true);
			if (isRecord(meta)) {
				expect(meta.status).toBe("complete");
				expect(meta.recommendation).toBe("caution");
			}

			// No analyzeResponse since scan threw
			expect(files.has("analyzeResponse.json")).toBe(false);
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);

	test("stub files exist even if enrichment is skipped (e.g. client abort)", async () => {
		const recordDir = path.join(os.tmpdir(), `assay-proxy-stub-abort-${Date.now()}`);

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

		let resolveBarrier: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			resolveBarrier = resolve;
		});
		let stubWritten = false;

		// Custom scanFn that blocks until we tell it to proceed — simulating
		// a long-running scan where we can check stub state mid-flight.
		const scanFn = async (
			_input: ScanInput,
			_ctx: { chain: Chain; config: Config },
		): Promise<ProxyScanOutcome> => {
			// Signal that scan has started (stub should be written by now)
			stubWritten = true;
			await barrier;
			return { recommendation: "ok", simulationSuccess: true };
		};

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			recordDir,
			once: true,
			exitOnOnce: false,
			policy: { threshold: "danger", onRisk: "block" },
			scanFn,
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

			// Fire request but don't await yet
			const fetchPromise = fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});

			// Wait for scan to start (stub should be on disk)
			const waitStart = Date.now();
			while (!stubWritten && Date.now() - waitStart < 5000) {
				await new Promise((r) => setTimeout(r, 50));
			}
			expect(stubWritten).toBe(true);

			// Verify stub files are on disk BEFORE scan completes
			const bundles = await readdir(recordDir);
			expect(bundles.length).toBe(1);
			const bundleDir = path.join(recordDir, bundles[0] ?? "");
			const files = new Set(await readdir(bundleDir));
			expect(files.has("rpc.json")).toBe(true);
			expect(files.has("calldata.json")).toBe(true);
			expect(files.has("meta.json")).toBe(true);

			// Meta should show "pending" status
			const meta = JSON.parse(await readFile(path.join(bundleDir, "meta.json"), "utf-8"));
			expect(isRecord(meta)).toBe(true);
			if (isRecord(meta)) {
				expect(meta.status).toBe("pending");
			}

			// Release the scan and let request complete
			resolveBarrier?.();
			const res = await fetchPromise;
			expect(res.status).toBe(200);
		} finally {
			resolveBarrier?.();
			proxy.stop(true);
			upstream.stop(true);
		}
	}, 20_000);
});
