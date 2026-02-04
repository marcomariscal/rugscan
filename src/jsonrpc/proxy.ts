import readline from "node:readline";
import { renderHeading, renderResultBox } from "../cli/ui";
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

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
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

async function defaultScanFn(
	input: ScanInput,
	options: { chain: Chain; config: Config; quiet: boolean },
): Promise<ProxyScanOutcome> {
	const { analysis, response } = await scanWithAnalysis(input, {
		chain: options.chain,
		config: options.config,
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
	const configPromise = options.config ? Promise.resolve(options.config) : loadConfig();
	let upstreamChainId: string | null = null;
	let handled = 0;

	const server = Bun.serve({
		hostname: options.hostname ?? "127.0.0.1",
		port: options.port ?? 8545,
		fetch: async (request: Request): Promise<Response> => {
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
				const id: JsonRpcId = "id" in entry ? (entry.id ?? null) : null;

				if (entry.method !== "eth_sendTransaction") {
					const upstreamResponse = await forwardToUpstream(
						options.upstreamUrl,
						JSON.stringify(entry),
					);
					const upstreamJson: unknown = await upstreamResponse.json().catch(() => null);
					if (!isJsonRpcResponse(upstreamJson)) {
						return jsonRpcError(id, -32000, "Upstream returned invalid JSON");
					}
					return upstreamJson;
				}

				const calldata = extractSendTransactionCalldata(entry);
				if (!calldata) {
					return jsonRpcError(id, -32602, "Invalid params for eth_sendTransaction");
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
					return jsonRpcError(id, -32602, "Unable to resolve chain");
				}

				const config = await configPromise;
				const input: ScanInput = {
					calldata: { ...calldata, chain: calldata.chain ?? upstreamChainId ?? undefined },
				};
				const validated = scanInputSchema.safeParse(input);
				if (!validated.success) {
					return jsonRpcError(id, -32602, "Invalid transaction fields");
				}

				let outcome: ProxyScanOutcome;
				try {
					const scanFn = options.scanFn
						? options.scanFn
						: async (scanInput: ScanInput, ctx: { chain: Chain; config: Config }) =>
								await defaultScanFn(scanInput, { ...ctx, quiet });
					outcome = await scanFn(validated.data, { chain, config });
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

				if (action === "prompt") {
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

				if (action === "block") {
					return jsonRpcError(id, 4001, "Transaction blocked by rugscan", {
						recommendation: outcome.recommendation,
						simulationSuccess: outcome.simulationSuccess,
					});
				}

				const upstreamResponse = await forwardToUpstream(options.upstreamUrl, rawBody);
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
					// Notifications (no id) should be ignored per JSON-RPC.
					if (res.id === undefined) continue;
					responses.push(res);
				}
				responsePayload = responses;
			} else {
				const res = await handleSingle(body);
				responsePayload = res ?? jsonRpcError(null, -32600, "Invalid Request");
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
