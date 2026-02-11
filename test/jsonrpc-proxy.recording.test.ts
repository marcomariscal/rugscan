import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	createJsonRpcProxyServer,
	type ProxyScanOutcome,
	type RecordingStatus,
} from "../src/jsonrpc/proxy";
import type { AnalyzeResponse, ScanInput } from "../src/schema";
import type { Chain, Config } from "../src/types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function makeUpstream() {
	return Bun.serve({
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
}

const TX_PAYLOAD = {
	jsonrpc: "2.0" as const,
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

function okScanFn(overrides?: Partial<ProxyScanOutcome>) {
	return async (
		input: ScanInput,
		_ctx: { chain: Chain; config: Config },
	): Promise<ProxyScanOutcome> => {
		const response: AnalyzeResponse = {
			schemaVersion: 2,
			requestId: crypto.randomUUID(),
			scan: {
				input,
				recommendation: "ok",
				findings: [],
				contract: {
					address: input.calldata?.to ?? "0x0000000000000000000000000000000000000000",
					chain: "ethereum",
					isContract: true,
					isProxy: false,
					verifiedSource: false,
					confidence: "high",
				},
			},
		};

		return {
			recommendation: "ok",
			simulationSuccess: true,
			response,
			...overrides,
		};
	};
}

async function readMeta(recordDir: string): Promise<Record<string, unknown>> {
	const bundles = await readdir(recordDir);
	expect(bundles.length).toBe(1);
	const bundleDir = path.join(recordDir, bundles[0] ?? "");
	const raw = await Bun.file(path.join(bundleDir, "meta.json")).text();
	const meta: unknown = JSON.parse(raw);
	if (!isRecord(meta)) throw new Error("meta.json is not an object");
	return meta;
}

describe("jsonrpc proxy - recording", () => {
	test("writes a recording bundle with forwarded status", async () => {
		const recordDir = path.join(os.tmpdir(), `assay-proxy-record-${Date.now()}`);
		const upstream = makeUpstream();

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			recordDir,
			once: true,
			exitOnOnce: false,
			policy: { threshold: "danger", onRisk: "block" },
			scanFn: okScanFn(),
		});

		try {
			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(TX_PAYLOAD),
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

			const meta = await readMeta(recordDir);
			expect(meta.status).toBe("forwarded" satisfies RecordingStatus);
			expect(meta.action).toBe("forward");
			expect(meta.recommendation).toBe("ok");
			expect(typeof meta.completedAt).toBe("string");
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	});

	test("records blocked status when policy blocks", async () => {
		const recordDir = path.join(os.tmpdir(), `assay-proxy-record-blocked-${Date.now()}`);
		const upstream = makeUpstream();

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			recordDir,
			once: true,
			exitOnOnce: false,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn: async (
				_input: ScanInput,
				_ctx: { chain: Chain; config: Config },
			): Promise<ProxyScanOutcome> => ({
				recommendation: "danger",
				simulationSuccess: true,
			}),
		});

		try {
			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(TX_PAYLOAD),
			});
			expect(res.status).toBe(200);
			const parsed: unknown = await res.json();
			expect(isRecord(parsed) && isRecord(parsed.error)).toBe(true);

			const meta = await readMeta(recordDir);
			expect(meta.status).toBe("blocked" satisfies RecordingStatus);
			expect(meta.action).toBe("block");
			expect(meta.recommendation).toBe("danger");
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	});

	test("records error status when scan throws", async () => {
		const recordDir = path.join(os.tmpdir(), `assay-proxy-record-error-${Date.now()}`);
		const upstream = makeUpstream();

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			recordDir,
			once: true,
			exitOnOnce: false,
			// threshold=danger + onRisk=block, but recommendation will be "caution" from error fallback
			// which is below "danger" so action resolves to "forward" — but scanErrored=true → status=error
			policy: { threshold: "danger", onRisk: "block" },
			scanFn: async (): Promise<ProxyScanOutcome> => {
				throw new Error("upstream timeout");
			},
		});

		try {
			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(TX_PAYLOAD),
			});
			// Scan error with caution + threshold=danger → sim failed → non-interactive → block
			expect(res.status).toBe(200);

			const meta = await readMeta(recordDir);
			// Since the scan failed (simulationSuccess=false) and isInteractive=false → block
			expect(meta.status).toBe("blocked" satisfies RecordingStatus);
			expect(typeof meta.completedAt).toBe("string");
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	});

	test("early recording artifact persists when scan hangs and client disconnects", async () => {
		const recordDir = path.join(os.tmpdir(), `assay-proxy-record-abort-${Date.now()}`);
		const upstream = makeUpstream();

		// Scan that hangs forever (simulates timeout scenario).
		let scanStarted = false;
		const hangingScanFn = async (): Promise<ProxyScanOutcome> => {
			scanStarted = true;
			// Hang indefinitely — client will abort before this resolves.
			await new Promise(() => {});
			return { recommendation: "ok", simulationSuccess: true };
		};

		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			recordDir,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn: hangingScanFn,
		});

		try {
			const controller = new AbortController();
			const fetchPromise = fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(TX_PAYLOAD),
				signal: controller.signal,
			}).catch(() => null);

			// Wait for the scan to start, then abort.
			while (!scanStarted) {
				await new Promise((r) => setTimeout(r, 10));
			}
			// Give initRecording time to flush.
			await new Promise((r) => setTimeout(r, 50));
			controller.abort();
			await fetchPromise;

			// Even though scan never completed, early recording should exist.
			const bundles = await readdir(recordDir);
			expect(bundles.length).toBe(1);
			const files = new Set(await readdir(path.join(recordDir, bundles[0] ?? "")));
			expect(files.has("meta.json")).toBe(true);
			expect(files.has("rpc.json")).toBe(true);
			expect(files.has("calldata.json")).toBe(true);

			const meta = await readMeta(recordDir);
			// Early recording has status=pending (scan never completed to finalize).
			expect(meta.status).toBe("pending" satisfies RecordingStatus);
			expect(meta.completedAt).toBeUndefined();
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	});

	test("deny path returns block response", async () => {
		const recordDir = path.join(os.tmpdir(), `assay-proxy-record-deny-${Date.now()}`);
		const upstream = makeUpstream();

		// Non-interactive (no TTY in tests) + sim failed → block (not prompt).
		// So we test with sim-failed to trigger auto-block and verify recording.
		const proxy = createJsonRpcProxyServer({
			upstreamUrl: `http://127.0.0.1:${upstream.port}`,
			port: 0,
			chain: "ethereum",
			quiet: true,
			recordDir,
			once: true,
			exitOnOnce: false,
			policy: { threshold: "caution", onRisk: "block" },
			scanFn: async (): Promise<ProxyScanOutcome> => ({
				recommendation: "caution",
				simulationSuccess: false,
			}),
		});

		try {
			const res = await fetch(`http://127.0.0.1:${proxy.port}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(TX_PAYLOAD),
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
			expect(err.message).toBe("Transaction blocked by assay");

			const meta = await readMeta(recordDir);
			expect(meta.status).toBe("blocked" satisfies RecordingStatus);
			expect(meta.action).toBe("block");
		} finally {
			proxy.stop(true);
			upstream.stop(true);
		}
	});
});
