import { mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { parseTransaction, recoverTransactionAddress } from "viem";
import { createProgressRenderer, renderHeading, renderResultBox } from "../cli/ui";
import { loadConfig } from "../config";
import { fetchWithTimeout } from "../http";
import { resolveScanChain, scanWithAnalysis } from "../scan";
import type { AnalyzeResponse, CalldataInput, ScanInput } from "../schema";
import { scanInputSchema } from "../schema";
import type { Chain, Config, Recommendation } from "../types";

export type RiskAction = "forward" | "block" | "prompt";

export interface ProxyPolicy {
	threshold: Recommendation;
	onRisk: Exclude<RiskAction, "forward">;
	allowPromptWhenSimulationFails: boolean;
}

export interface ProxyOptions {
	upstreamUrl: string;
	hostname?: string;
	port?: number;
	chain?: string;
	policy?: Partial<ProxyPolicy>;
	config?: Config;
	once?: boolean;
	quiet?: boolean;
	recordDir?: string;
	scanFn?: (
		input: ScanInput,
		options: { chain: Chain; config: Config },
	) => Promise<ProxyScanOutcome>;
}

export interface ProxyScanOutcome {
	recommendation: Recommendation;
	simulationSuccess: boolean;
	response?: AnalyzeResponse;
	renderedText?: string;
}

interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
}

interface JsonRpcFailure {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: JsonRpcId;
	method: string;
	params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	if (!isRecord(value)) return false;
	if (value.jsonrpc !== "2.0") return false;
	if (typeof value.method !== "string") return false;
	if ("id" in value) {
		const id = value.id;
		if (id !== null && typeof id !== "string" && typeof id !== "number") return false;
	}
	return true;
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
	if (!isRecord(value)) return false;
	if (value.jsonrpc !== "2.0") return false;
	if (!("id" in value)) return false;
	const id = value.id;
	if (id !== null && typeof id !== "string" && typeof id !== "number") return false;
	if ("result" in value) return true;
	if ("error" in value) {
		const error = value.error;
		return isRecord(error) && typeof error.code === "number" && typeof error.message === "string";
	}
	return false;
}

function jsonRpcError(
	id: JsonRpcId,
	code: number,
	message: string,
	data?: unknown,
): JsonRpcFailure {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message,
			...(data === undefined ? {} : { data }),
		},
	};
}

function corsHeaders(): Record<string, string> {
	return {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "POST, OPTIONS, GET",
		"access-control-allow-headers": "content-type, authorization",
		"access-control-max-age": "86400",
	};
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json", ...corsHeaders() },
	});
}

function normalizeRecommendation(value: Recommendation): Recommendation {
	return value;
}

const RECOMMENDATION_ORDER: Recommendation[] = ["ok", "caution", "warning", "danger"];

function recommendationAtLeast(actual: Recommendation, threshold: Recommendation): boolean {
	const actualIndex = RECOMMENDATION_ORDER.indexOf(actual);
	const thresholdIndex = RECOMMENDATION_ORDER.indexOf(threshold);
	if (actualIndex === -1 || thresholdIndex === -1) return true;
	return actualIndex >= thresholdIndex;
}

export function decideRiskAction(options: {
	recommendation: Recommendation;
	simulationSuccess: boolean;
	policy: ProxyPolicy;
	isInteractive: boolean;
}): RiskAction {
	const isRisky = recommendationAtLeast(options.recommendation, options.policy.threshold);
	const simulationFailed = !options.simulationSuccess;
	if (!isRisky && !simulationFailed) return "forward";

	if (!options.isInteractive) return "block";
	if (simulationFailed && !options.policy.allowPromptWhenSimulationFails) return "block";
	return options.policy.onRisk;
}

function parseQuantity(value: unknown): bigint | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
			return BigInt(trimmed);
		}
		if (/^\d+$/.test(trimmed)) {
			return BigInt(trimmed);
		}
		return null;
	} catch {
		return null;
	}
}

function parseAddressField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseHexDataField(value: unknown): string {
	if (typeof value !== "string") return "0x";
	return value.length > 0 ? value : "0x";
}

function isHexString(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (!/^0x[0-9a-fA-F]*$/.test(value)) return false;
	// Must be even length (each byte = 2 hex chars)
	return (value.length - 2) % 2 === 0;
}

export function extractSendTransactionCalldata(request: JsonRpcRequest): CalldataInput | null {
	if (request.method !== "eth_sendTransaction") return null;
	const params = request.params;
	if (!Array.isArray(params) || params.length < 1) return null;
	const tx = params[0];
	if (!isRecord(tx)) return null;

	const to = parseAddressField(tx.to);
	if (!to) return null;

	const from = parseAddressField(tx.from);
	const data = parseHexDataField(tx.data);

	const chainId = parseQuantity(tx.chainId);
	const value = parseQuantity(tx.value);

	return {
		to,
		from,
		data,
		value: value === null ? undefined : value.toString(),
		chain: chainId === null ? undefined : chainId.toString(),
	};
}

export async function extractSendRawTransactionCalldata(
	request: JsonRpcRequest,
): Promise<CalldataInput | null> {
	if (request.method !== "eth_sendRawTransaction") return null;
	const params = request.params;
	if (!Array.isArray(params) || params.length < 1) return null;
	const raw = params[0];
	if (!isHexString(raw) || raw === "0x") return null;

	try {
		const parsed = parseTransaction(raw);
		const to = typeof parsed.to === "string" ? parsed.to : undefined;
		if (!to) return null;
		const from = await recoverTransactionAddress({ serializedTransaction: raw });
		const value = parsed.value ?? 0n;
		const data = typeof parsed.data === "string" ? parsed.data : "0x";
		const chainId = parsed.chainId;

		return {
			to,
			from,
			data,
			value: value.toString(),
			chain: chainId === undefined ? undefined : chainId.toString(),
		};
	} catch {
		return null;
	}
}

async function getUpstreamChainId(upstreamUrl: string): Promise<string | null> {
	const payload: JsonRpcRequest = {
		jsonrpc: "2.0",
		id: 1,
		method: "eth_chainId",
		params: [],
	};
	try {
		const response = await fetchWithTimeout(upstreamUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!response.ok) return null;
		const parsed: unknown = await response.json();
		if (!isRecord(parsed)) return null;
		const result = parsed.result;
		const chainId = parseQuantity(result);
		return chainId === null ? null : chainId.toString();
	} catch {
		return null;
	}
}

function resolveChainFromInputs(options: {
	upstreamChainId: string | null;
	requestedChain: string | undefined;
	calldataChain: string | undefined;
}): Chain | null {
	const candidates = [
		options.calldataChain,
		options.requestedChain,
		options.upstreamChainId,
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	for (const candidate of candidates) {
		const chain = resolveScanChain(candidate);
		if (chain) return chain;
	}
	return null;
}

async function promptYesNo(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await new Promise<string>((resolve) => {
			rl.question(question, (value) => resolve(value));
		});
		return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
	} finally {
		rl.close();
	}
}

async function forwardToUpstream(upstreamUrl: string, rawBody: string): Promise<Response> {
	return await fetchWithTimeout(upstreamUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: rawBody,
	});
}

function defaultPolicy(options?: Partial<ProxyPolicy>): ProxyPolicy {
	return {
		threshold: options?.threshold ?? "caution",
		onRisk: options?.onRisk ?? "prompt",
		allowPromptWhenSimulationFails: options?.allowPromptWhenSimulationFails ?? true,
	};
}

function sanitizeFilenamePart(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "")
		.slice(0, 80);
}

function isoStampForFilename(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

async function writeRecording(options: {
	recordDir: string;
	chain: Chain;
	method: string;
	calldata: CalldataInput;
	rpcRequest: JsonRpcRequest;
	outcome: ProxyScanOutcome;
	action: RiskAction;
}): Promise<void> {
	const now = new Date();
	const base = [
		isoStampForFilename(now),
		sanitizeFilenamePart(options.method),
		sanitizeFilenamePart(options.chain),
		sanitizeFilenamePart(options.calldata.to),
		sanitizeFilenamePart(options.calldata.from ?? "unknown"),
		crypto.randomUUID().slice(0, 8),
	]
		.filter(Boolean)
		.join("__");

	const dir = path.join(options.recordDir, base);
	await mkdir(dir, { recursive: true });

	const meta = {
		createdAt: now.toISOString(),
		chain: options.chain,
		method: options.method,
		calldata: options.calldata,
		action: options.action,
		recommendation: options.outcome.recommendation,
		simulationSuccess: options.outcome.simulationSuccess,
	};

	await Bun.write(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
	await Bun.write(path.join(dir, "rpc.json"), JSON.stringify(options.rpcRequest, null, 2));
	await Bun.write(path.join(dir, "calldata.json"), JSON.stringify(options.calldata, null, 2));

	if (options.outcome.response) {
		await Bun.write(
			path.join(dir, "analyzeResponse.json"),
			JSON.stringify(options.outcome.response, null, 2),
		);
	}
	if (options.outcome.renderedText) {
		await Bun.write(path.join(dir, "rendered.txt"), options.outcome.renderedText);
	}
}

async function defaultScanFn(
	input: ScanInput,
	options: { chain: Chain; config: Config; quiet: boolean },
): Promise<ProxyScanOutcome> {
	const progress = options.quiet
		? undefined
		: createProgressRenderer(Boolean(process.stdout.isTTY));

	const { analysis, response } = await scanWithAnalysis(input, {
		chain: options.chain,
		config: options.config,
		progress,
	});
	const renderedText = options.quiet
		? undefined
		: `${renderHeading(`Tx scan on ${options.chain}`)}\n\n${renderResultBox(analysis, {
				hasCalldata: Boolean(input.calldata),
			})}\n`;

	return {
		recommendation: normalizeRecommendation(response.scan.recommendation),
		simulationSuccess: Boolean(analysis.simulation?.success),
		response,
		renderedText,
	};
}

export function createJsonRpcProxyServer(options: ProxyOptions) {
	const policy = defaultPolicy(options.policy);
	const quiet = options.quiet ?? false;
	const recordDir =
		typeof options.recordDir === "string" && options.recordDir.trim().length > 0
			? options.recordDir.trim()
			: null;
	const configPromise = options.config ? Promise.resolve(options.config) : loadConfig();
	let upstreamChainId: string | null = null;
	let handled = 0;
	let scanQueue: Promise<void> = Promise.resolve();

	const server = Bun.serve({
		hostname: options.hostname ?? "127.0.0.1",
		port: options.port ?? 8545,
		fetch: async (request: Request): Promise<Response> => {
			if (request.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders() });
			}
			if (request.method === "GET") {
				return jsonResponse({ ok: true, name: "rugscan-jsonrpc-proxy" }, 200);
			}
			if (request.method !== "POST") {
				return jsonResponse(jsonRpcError(null, -32601, "Method not allowed"), 405);
			}

			let rawBody: string;
			let body: unknown;
			try {
				rawBody = await request.text();
				body = JSON.parse(rawBody);
			} catch {
				return jsonResponse(jsonRpcError(null, -32700, "Parse error"), 400);
			}

			const handleSingle = async (
				entry: unknown,
			): Promise<JsonRpcSuccess | JsonRpcFailure | null> => {
				if (!isJsonRpcRequest(entry)) {
					return jsonRpcError(null, -32600, "Invalid Request");
				}
				const idPresent = "id" in entry;
				const id: JsonRpcId = idPresent ? (entry.id ?? null) : null;
				const isNotification = !idPresent;

				const isInterceptable =
					entry.method === "eth_sendTransaction" || entry.method === "eth_sendRawTransaction";
				if (!isInterceptable) {
					const upstreamResponse = await forwardToUpstream(
						options.upstreamUrl,
						JSON.stringify(entry),
					);
					if (isNotification) {
						// JSON-RPC notifications must not receive a response.
						return null;
					}
					const upstreamJson: unknown = await upstreamResponse.json().catch(() => null);
					if (!isJsonRpcResponse(upstreamJson)) {
						return jsonRpcError(id, -32000, "Upstream returned invalid JSON");
					}
					return upstreamJson;
				}

				const calldata =
					entry.method === "eth_sendTransaction"
						? extractSendTransactionCalldata(entry)
						: await extractSendRawTransactionCalldata(entry);
				if (!calldata) {
					if (isNotification) return null;
					const message =
						entry.method === "eth_sendRawTransaction"
							? "Invalid params for eth_sendRawTransaction"
							: "Invalid params for eth_sendTransaction";
					return jsonRpcError(id, -32602, message);
				}

				if (upstreamChainId === null) {
					upstreamChainId = await getUpstreamChainId(options.upstreamUrl);
				}

				const chain = resolveChainFromInputs({
					upstreamChainId,
					requestedChain: options.chain,
					calldataChain: calldata.chain,
				});
				if (!chain) {
					return isNotification ? null : jsonRpcError(id, -32602, "Unable to resolve chain");
				}

				const config = await configPromise;
				const input: ScanInput = {
					calldata: { ...calldata, chain: calldata.chain ?? upstreamChainId ?? undefined },
				};
				const validated = scanInputSchema.safeParse(input);
				if (!validated.success) {
					return isNotification ? null : jsonRpcError(id, -32602, "Invalid transaction fields");
				}

				let outcome: ProxyScanOutcome;
				try {
					const scanFn = options.scanFn
						? options.scanFn
						: async (scanInput: ScanInput, ctx: { chain: Chain; config: Config }) =>
								await defaultScanFn(scanInput, { ...ctx, quiet });

					const queued = scanQueue.then(async () => {
						return await scanFn(validated.data, { chain, config });
					});
					scanQueue = queued.then(
						() => undefined,
						() => undefined,
					);

					outcome = await queued;
				} catch (error) {
					const message = error instanceof Error ? error.message : "scan failed";
					outcome = {
						recommendation: "caution",
						simulationSuccess: false,
						renderedText: quiet ? undefined : `Scan failed: ${message}`,
					};
				}

				if (!quiet && outcome.renderedText) {
					process.stdout.write(`${outcome.renderedText}\n`);
				}

				const action = decideRiskAction({
					recommendation: outcome.recommendation,
					simulationSuccess: outcome.simulationSuccess,
					policy,
					isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
				});

				if (recordDir) {
					const recording = writeRecording({
						recordDir,
						chain,
						method: entry.method,
						calldata,
						rpcRequest: entry,
						outcome,
						action,
					});
					if (options.once) {
						await recording;
					} else {
						recording.catch(() => undefined);
					}
				}

				if (action === "prompt") {
					if (isNotification) {
						// No response channel. Default to blocking unless the user explicitly forwards.
						const ok = await promptYesNo(
							`Forward transaction anyway? (recommendation=${outcome.recommendation}, simulation=${
								outcome.simulationSuccess ? "ok" : "failed"
							}) [y/N] `,
						);
						if (!ok) return null;
					} else {
						const ok = await promptYesNo(
							`Forward transaction anyway? (recommendation=${outcome.recommendation}, simulation=${
								outcome.simulationSuccess ? "ok" : "failed"
							}) [y/N] `,
						);
						if (!ok) {
							return jsonRpcError(id, 4001, "Transaction blocked by rugscan", {
								recommendation: outcome.recommendation,
								simulationSuccess: outcome.simulationSuccess,
							});
						}
					}
				}

				if (action === "block") {
					return isNotification
						? null
						: jsonRpcError(id, 4001, "Transaction blocked by rugscan", {
								recommendation: outcome.recommendation,
								simulationSuccess: outcome.simulationSuccess,
							});
				}

				const upstreamResponse = await forwardToUpstream(
					options.upstreamUrl,
					JSON.stringify(entry),
				);
				if (isNotification) {
					return null;
				}
				const upstreamJson: unknown = await upstreamResponse.json().catch(() => null);
				if (!isJsonRpcResponse(upstreamJson)) {
					return jsonRpcError(id, -32000, "Upstream returned invalid JSON");
				}
				return upstreamJson;
			};

			let responsePayload: unknown;
			if (Array.isArray(body)) {
				const responses: Array<JsonRpcSuccess | JsonRpcFailure> = [];
				for (const entry of body) {
					const res = await handleSingle(entry);
					if (!res) continue;
					responses.push(res);
				}
				if (responses.length === 0) {
					return new Response(null, { status: 204, headers: corsHeaders() });
				}
				responsePayload = responses;
			} else {
				const res = await handleSingle(body);
				if (!res) {
					return new Response(null, { status: 204, headers: corsHeaders() });
				}
				responsePayload = res;
			}

			handled += 1;
			if (options.once && handled >= 1) {
				queueMicrotask(() => {
					server.stop(true);
					process.exit(0);
				});
			}

			return jsonResponse(responsePayload, 200);
		},
	});

	return server;
}
