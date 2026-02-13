import { loadConfig } from "../config";
import { resolveScanChain, scan } from "../scan";
import type { AnalyzeResponse, ScanInput } from "../schema";
import { analyzeResponseSchema, parseScanRequest, scanRequestSchema } from "../schema";
import { createProxyTelemetry, type ProxyTelemetry } from "../telemetry";
import type { Config } from "../types";

export interface ServerOptions {
	apiKey?: string;
	scanFn?: (
		input: ScanInput,
		options?: { chain?: string; config?: Config },
	) => Promise<AnalyzeResponse>;
	config?: Config;
	telemetry?: ProxyTelemetry;
}

export function createScanHandler(options: ServerOptions = {}) {
	const apiKey = options.apiKey ?? process.env.ASSAY_API_KEY;
	const scanFn = options.scanFn ?? scan;
	const configPromise = options.config ? Promise.resolve(options.config) : loadConfig();
	const telemetry =
		options.telemetry ??
		createProxyTelemetry({
			source: "server",
			onError: (error) => {
				if (process.env.ASSAY_TELEMETRY_DEBUG !== "1") return;
				const message = error instanceof Error ? error.message : String(error);
				process.stderr.write(`telemetry error: ${message}\n`);
			},
		});

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (url.pathname !== "/v1/scan") {
			return jsonResponse({ error: "Not found" }, 404);
		}
		if (request.method !== "POST") {
			return jsonResponse({ error: "Method not allowed" }, 405);
		}
		if (!apiKey) {
			return jsonResponse({ error: "Server API key not configured" }, 500);
		}

		const authHeader = request.headers.get("authorization");
		const token = parseBearerToken(authHeader);
		if (!token || token !== apiKey) {
			return jsonResponse({ error: "Unauthorized" }, 401);
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return jsonResponse({ error: "Invalid JSON" }, 400);
		}

		if (!isRecord(body)) {
			return jsonResponse({ error: "Invalid request" }, 400);
		}

		const hasAddress = typeof body.address === "string";
		const hasCalldata = isRecord(body.calldata);
		if (!hasAddress && !hasCalldata) {
			return jsonResponse({ error: "Missing address or calldata" }, 400);
		}
		if (hasAddress && hasCalldata) {
			return jsonResponse({ error: "Provide either address or calldata" }, 400);
		}

		const validation = scanRequestSchema.safeParse(body);
		if (!validation.success) {
			return jsonResponse({ error: "Invalid request body" }, 422);
		}

		const parsed = parseScanRequest(body);
		if (parsed.chain) {
			const chain = resolveScanChain(parsed.chain);
			if (!chain) {
				return jsonResponse({ error: "Invalid chain" }, 422);
			}
		}
		if (parsed.input.calldata?.chain) {
			const chain = resolveScanChain(parsed.input.calldata.chain);
			if (!chain) {
				return jsonResponse({ error: "Invalid chain" }, 422);
			}
		}

		const correlationId = crypto.randomUUID();
		const startedAt = Date.now();
		const telemetryChain =
			resolveScanChain(parsed.input.calldata?.chain ?? parsed.chain ?? "ethereum") ?? "unknown";
		const telemetryTarget = parsed.input.address ?? parsed.input.calldata?.to;
		safeEmitTelemetry(() => {
			telemetry.emitScanStarted({
				correlationId,
				chain: telemetryChain,
				actorAddress: parsed.input.calldata?.from,
				to: telemetryTarget,
				data: parsed.input.calldata?.data ?? "0x",
				value: parsed.input.calldata?.value,
				method: "assay_scan",
				inputKind: parsed.input.address ? "address" : "calldata",
				threshold: "caution",
				offline: false,
			});
		});

		try {
			const config = await configPromise;
			const response = await scanFn(parsed.input, {
				chain: parsed.chain,
				config,
			});

			const output = analyzeResponseSchema.safeParse(response);
			if (!output.success) {
				return jsonResponse({ error: "Invalid scan response" }, 500);
			}

			safeEmitTelemetry(() => {
				telemetry.emitScanResult({
					correlationId,
					chain: telemetryChain,
					actorAddress: parsed.input.calldata?.from,
					to: telemetryTarget,
					data: parsed.input.calldata?.data ?? "0x",
					value: parsed.input.calldata?.value,
					requestId: output.data.requestId,
					recommendation: output.data.scan.recommendation,
					simulationStatus: simulationStatusForTelemetry(output.data),
					findingCodes: findingCodesForTelemetry(output.data),
					latencyMs: Date.now() - startedAt,
				});
			});

			return jsonResponse(output.data, 200);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Internal error";
			return jsonResponse({ error: message }, 500);
		}
	};
}

export function createServer(options: ServerOptions & { port?: number } = {}) {
	const handler = createScanHandler(options);
	return Bun.serve({
		port: options.port ?? 3000,
		fetch: handler,
	});
}

function parseBearerToken(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	return match[1]?.trim() ?? null;
}

function simulationStatusForTelemetry(response: AnalyzeResponse): "success" | "failed" | "not_run" {
	const status = response.scan.simulation?.status;
	if (status === "success" || status === "failed" || status === "not_run") {
		return status;
	}
	return "not_run";
}

function findingCodesForTelemetry(response: AnalyzeResponse): string[] {
	const codes: string[] = [];
	for (const finding of response.scan.findings) {
		if (!finding.code) continue;
		codes.push(finding.code);
		if (codes.length >= 5) break;
	}
	return codes;
}

function safeEmitTelemetry(emit: () => void): void {
	try {
		emit();
	} catch {
		// Telemetry is best-effort only.
	}
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
