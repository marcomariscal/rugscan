import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { ScanProgress } from "../src/scan";
import { scanWithAnalysis } from "../src/scan";
import type { Config } from "../src/types";

function extractUrlString(input: RequestInfo | URL): string | null {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	if (input instanceof Request) return input.url;
	return null;
}

function normalizeHttpUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const normalizedPath = parsed.pathname === "/" ? "" : parsed.pathname;
		const normalized = `${parsed.protocol}//${parsed.host}${normalizedPath}${parsed.search}`;
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return url.endsWith("/") ? url.slice(0, -1) : url;
	}
}

async function startRpcStubServer(): Promise<{ rpcUrl: string; close: () => Promise<void> }> {
	const server = createServer(async (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end();
			return;
		}

		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		const body = Buffer.concat(chunks).toString("utf8");
		let payload: unknown;
		try {
			payload = JSON.parse(body);
		} catch {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "parse error" },
				}),
			);
			return;
		}

		const requests = Array.isArray(payload) ? payload : [payload];
		const responses: unknown[] = [];

		for (const entry of requests) {
			if (!isJsonRpcRequest(entry)) {
				responses.push({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32600, message: "invalid request" },
				});
				continue;
			}

			responses.push(handleJsonRpc(entry));
		}

		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
	});

	const rpcUrl = await new Promise<string>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("failed to bind rpc stub"));
				return;
			}
			resolve(`http://127.0.0.1:${address.port}`);
		});
	});

	return {
		rpcUrl,
		close: async () =>
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			}),
	};
}

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	if (!isRecord(value)) return false;
	return value.jsonrpc === "2.0" && typeof value.method === "string";
}

function handleJsonRpc(req: JsonRpcRequest): unknown {
	const id = req.id ?? null;
	const method = req.method;

	if (method === "eth_chainId") {
		return { jsonrpc: "2.0", id, result: "0x1" };
	}
	if (method === "eth_getCode") {
		// Non-empty bytecode so rugscan treats it as a contract.
		return { jsonrpc: "2.0", id, result: "0x60006000" };
	}
	if (method === "eth_getStorageAt") {
		return { jsonrpc: "2.0", id, result: `0x${"0".repeat(64)}` };
	}

	// Default: return a safe zero-ish value.
	return { jsonrpc: "2.0", id, result: "0x0" };
}

let restoreFetch: (() => void) | null = null;

afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

describe("offline / rpc-only mode", () => {
	test("makes zero non-RPC HTTP calls (providers + token lists + explorers blocked)", async () => {
		const rpc = await startRpcStubServer();
		try {
			const allowed = normalizeHttpUrl(rpc.rpcUrl);
			const originalFetch = globalThis.fetch;

			const httpCalls: string[] = [];
			const blockedCalls: string[] = [];

			globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = extractUrlString(input);
				if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
					httpCalls.push(url);
					const normalized = normalizeHttpUrl(url);
					if (normalized !== allowed) {
						blockedCalls.push(url);
						throw new Error(`blocked by test fetch guard: ${url}`);
					}
				}
				return await originalFetch(input, init);
			};
			restoreFetch = () => {
				globalThis.fetch = originalFetch;
			};

			const progressEvents: Array<{ provider: string; message?: string; status: string }> = [];
			const progress: ScanProgress = (event) => {
				progressEvents.push(event);
			};

			const config: Config = {
				rpcUrls: { ethereum: rpc.rpcUrl },
				// Make sure the analysis would normally attempt external providers.
				etherscanKeys: { ethereum: "test" },
				simulation: { enabled: false },
			};

			await scanWithAnalysis(
				{
					calldata: {
						to: "0x1111111111111111111111111111111111111111",
						from: "0x2222222222222222222222222222222222222222",
						data: "0x12345678",
					},
				},
				{ chain: "ethereum", config, offline: true, progress },
			);

			expect(blockedCalls).toEqual([]);
			expect(httpCalls.length).toBeGreaterThan(0);

			const skipped = progressEvents.filter((e) => e.message === "skipped (--offline)");
			expect(skipped.length).toBeGreaterThan(0);
		} finally {
			await rpc.close();
		}
	});
});
