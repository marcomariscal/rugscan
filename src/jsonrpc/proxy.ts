import { mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { parseTransaction, recoverTransactionAddress, serializeTransaction } from "viem";
import { createProgressRenderer, renderHeading, renderResultBox } from "../cli/ui";
import { loadConfig } from "../config";
import { fetchWithTimeout } from "../http";
import { resolveScanChain, scanWithAnalysis } from "../scan";
import type { AnalyzeResponse, AuthorizationEntry, CalldataInput, ScanInput } from "../schema";
import { scanInputSchema } from "../schema";
import { getAnvilClient } from "../simulations/anvil";
import { nowMs, TimingStore } from "../timing";
import type { Chain, Config, Recommendation } from "../types";
import {
	analyzeSignTypedDataV4Risk,
	extractSignTypedDataV4Payload,
	type TypedDataRiskAssessment,
} from "./sign-typed-data";

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
	/**
	 * Strict offline mode: allow only explicitly configured JSON-RPC URL(s).
	 *
	 * Note: localhost fetches (ex: local Anvil) are allowed by default.
	 */
	offline?: boolean;
	// When once=true, optionally terminate the process after the first intercepted send request.
	// Default: true (used by CLI); tests may set false.
	exitOnOnce?: boolean;
	quiet?: boolean;
	showTimings?: boolean;
	recordDir?: string;
	scanFn?: (
		input: ScanInput,
		options: {
			chain: Chain;
			config: Config;
			quiet?: boolean;
			timings?: TimingStore;
			offline?: boolean;
		},
	) => Promise<ProxyScanOutcome>;
}

export interface ProxyScanOutcome {
	recommendation: Recommendation;
	simulationSuccess: boolean;
	response?: AnalyzeResponse;
	renderedText?: string;
	blockData?: Record<string, unknown>;
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

function ensureRecommendationAtLeast(
	actual: Recommendation,
	minimum: Recommendation,
): Recommendation {
	return recommendationAtLeast(actual, minimum) ? actual : minimum;
}

type AllowlistViolationKind = "target" | "approvalSpender";

interface AllowlistViolation {
	kind: AllowlistViolationKind;
	address: string;
	source: "to" | "simulation" | "calldata";
}

interface AllowlistEvaluation {
	enabled: boolean;
	violations: AllowlistViolation[];
	unknownApprovalSpenders: boolean;
}

function shortenHexAddress(value: string): string {
	const v = value.toLowerCase();
	if (!v.startsWith("0x") || v.length !== 42) return value;
	return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

function formatAllowlistSummary(allowlist: AllowlistEvaluation): string {
	if (!allowlist.enabled) return "";
	const parts: string[] = [];
	if (allowlist.violations.length > 0) {
		const v = allowlist.violations
			.map((violation) => `${violation.kind}:${shortenHexAddress(violation.address)}`)
			.join(", ");
		parts.push(`violations=${v}`);
	}
	if (allowlist.unknownApprovalSpenders) {
		parts.push("unknownApprovalSpenders");
	}
	return parts.length > 0 ? `, allowlist(${parts.join("; ")})` : ", allowlist(ok)";
}

function evaluateAllowlist(options: {
	calldata: CalldataInput;
	config: Config;
	outcome: ProxyScanOutcome;
}): AllowlistEvaluation {
	const allowlist = options.config.allowlist;
	const allowToEntries = allowlist?.to;
	const allowSpenderEntries = allowlist?.spenders;
	const hasToAllowlist = Array.isArray(allowToEntries);
	const hasSpenderAllowlist = Array.isArray(allowSpenderEntries);

	if (!hasToAllowlist && !hasSpenderAllowlist) {
		return { enabled: false, violations: [], unknownApprovalSpenders: false };
	}

	const allowTo = hasToAllowlist ? new Set(allowToEntries.map((v) => v.toLowerCase())) : null;
	const allowSpenders = hasSpenderAllowlist
		? new Set(allowSpenderEntries.map((v) => v.toLowerCase()))
		: null;

	const violations: AllowlistViolation[] = [];
	const target = options.calldata.to.toLowerCase();
	if (allowTo && !allowTo.has(target)) {
		violations.push({ kind: "target", address: options.calldata.to, source: "to" });
	}

	const touchedSpenders = new Set<string>();
	const spenderSource = new Map<string, AllowlistViolation["source"]>();
	if (allowSpenders) {
		for (const spender of extractApprovalSpendersFromResponse(options.outcome.response)) {
			const normalized = spender.toLowerCase();
			touchedSpenders.add(normalized);
			spenderSource.set(normalized, "simulation");
		}
		for (const spender of extractApprovalSpendersFromFindings(
			options.outcome.response?.scan.findings,
		)) {
			const normalized = spender.toLowerCase();
			touchedSpenders.add(normalized);
			if (!spenderSource.has(normalized)) {
				spenderSource.set(normalized, "calldata");
			}
		}

		for (const spender of touchedSpenders) {
			if (!allowSpenders.has(spender)) {
				violations.push({
					kind: "approvalSpender",
					address: spender,
					source: spenderSource.get(spender) ?? "calldata",
				});
			}
		}
	}

	const unknownApprovalSpenders = Boolean(
		allowSpenders && !options.outcome.simulationSuccess && touchedSpenders.size === 0,
	);

	return {
		enabled: true,
		violations,
		unknownApprovalSpenders,
	};
}

function evaluateTypedDataAllowlist(options: {
	config: Config;
	assessment: TypedDataRiskAssessment;
}): AllowlistEvaluation {
	const allowSpenderEntries = options.config.allowlist?.spenders;
	if (!Array.isArray(allowSpenderEntries)) {
		return { enabled: false, violations: [], unknownApprovalSpenders: false };
	}
	if (!options.assessment.permitLike) {
		return { enabled: true, violations: [], unknownApprovalSpenders: false };
	}

	const allowSpenders = new Set(allowSpenderEntries.map((v) => v.toLowerCase()));
	const spender = options.assessment.spender?.toLowerCase();
	if (!spender) {
		return { enabled: true, violations: [], unknownApprovalSpenders: true };
	}
	if (allowSpenders.has(spender)) {
		return { enabled: true, violations: [], unknownApprovalSpenders: false };
	}
	return {
		enabled: true,
		violations: [{ kind: "approvalSpender", address: spender, source: "calldata" }],
		unknownApprovalSpenders: false,
	};
}

function renderTypedDataAssessment(options: {
	assessment: TypedDataRiskAssessment;
	resolvedChain: Chain | null;
}): string {
	const chainLabel =
		options.resolvedChain ??
		(options.assessment.chainId ? `chain ${options.assessment.chainId}` : "unknown chain");
	const lines = [
		renderHeading(`Typed-data signature scan on ${chainLabel}`),
		"",
		"Method: eth_signTypedData_v4",
		`Recommendation: ${options.assessment.recommendation.toUpperCase()}`,
		`Primary type: ${options.assessment.primaryType ?? "unknown"}`,
		...(options.assessment.actionableNotes.length > 0
			? ["", ...options.assessment.actionableNotes.map((note) => `- ${note}`)]
			: []),
	];
	return `${lines.join("\n")}\n`;
}

function buildTypedDataBlockData(assessment: TypedDataRiskAssessment): Record<string, unknown> {
	return {
		typedData: {
			method: "eth_signTypedData_v4",
			permitLike: assessment.permitLike,
			primaryType: assessment.primaryType,
			chainId: assessment.chainId,
			spender: assessment.spender,
			token: assessment.token,
			amount: assessment.amount,
			deadline: assessment.deadline,
			findings: assessment.findings,
			actionableNotes: assessment.actionableNotes,
		},
	};
}

function extractApprovalSpendersFromResponse(response: AnalyzeResponse | undefined): string[] {
	const approvals = response?.scan.simulation?.approvals.changes;
	if (!approvals) return [];
	const result: string[] = [];
	for (const approval of approvals) {
		const spender = approval.spender;
		if (typeof spender !== "string") continue;
		if (!isAddress(spender)) continue;
		result.push(spender);
	}
	return result;
}

function extractApprovalSpendersFromFindings(
	findings: AnalyzeResponse["scan"]["findings"] | undefined,
): string[] {
	if (!findings) return [];
	const result: string[] = [];
	for (const finding of findings) {
		if (finding.code !== "CALLDATA_DECODED") continue;
		const details = finding.details;
		if (!details || !isRecord(details)) continue;

		const args = details.args;
		const argNames = details.argNames;

		const spender = extractNamedArg(args, argNames, "spender");
		if (spender) {
			result.push(spender);
			continue;
		}

		const operator = extractNamedArg(args, argNames, "operator");
		if (operator) {
			result.push(operator);
		}
	}
	return result;
}

function extractNamedArg(args: unknown, argNames: unknown, name: string): string | null {
	if (isRecord(args)) {
		const value = args[name];
		if (typeof value === "string" && isAddress(value)) return value;
		return null;
	}
	if (Array.isArray(args) && Array.isArray(argNames)) {
		for (let i = 0; i < argNames.length; i += 1) {
			if (argNames[i] !== name) continue;
			const value = args[i];
			if (typeof value === "string" && isAddress(value)) return value;
		}
	}
	return null;
}

/* unused helper removed */

function isAddress(value: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function buildProxyBlockData(
	outcome: ProxyScanOutcome,
	allowlist: AllowlistEvaluation,
): Record<string, unknown> {
	const data: Record<string, unknown> = {
		recommendation: outcome.recommendation,
		simulationSuccess: outcome.simulationSuccess,
	};
	if (allowlist.enabled) {
		data.allowlist = {
			violations: allowlist.violations,
			unknownApprovalSpenders: allowlist.unknownApprovalSpenders,
		};
	}
	if (outcome.blockData) {
		for (const [key, value] of Object.entries(outcome.blockData)) {
			data[key] = value;
		}
	}
	return data;
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

function isHexString(value: unknown): value is `0x${string}` {
	if (typeof value !== "string") return false;
	if (!/^0x[0-9a-fA-F]*$/.test(value)) return false;
	// Must be even length (each byte = 2 hex chars)
	return (value.length - 2) % 2 === 0;
}

/**
 * Parse an EIP-7702 authorizationList from eth_sendTransaction params.
 * Returns empty array if the field is absent or malformed.
 */
function parseAuthorizationListField(value: unknown): AuthorizationEntry[] {
	if (!Array.isArray(value)) return [];
	const result: AuthorizationEntry[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const address = typeof entry.address === "string" ? entry.address : null;
		if (!address || !isAddress(address)) continue;
		const chainId = parseQuantity(entry.chainId);
		const nonce = parseQuantity(entry.nonce);
		result.push({
			address,
			chainId: chainId === null ? 0 : Number(chainId),
			nonce: nonce === null ? 0 : Number(nonce),
		});
	}
	return result;
}

/**
 * Extract EIP-7702 authorization list from a viem-parsed transaction.
 * Works for type-4 (eip7702) transactions parsed by `parseTransaction`.
 */
function extractAuthorizationListFromParsedTx(
	parsed: Record<string, unknown>,
): AuthorizationEntry[] {
	const authList = parsed.authorizationList;
	if (!Array.isArray(authList)) return [];
	const result: AuthorizationEntry[] = [];
	for (const entry of authList) {
		if (!isRecord(entry)) continue;
		const address = typeof entry.address === "string" ? entry.address : null;
		if (!address || !isAddress(address)) continue;
		const chainId = typeof entry.chainId === "number" ? entry.chainId : 0;
		const nonce = typeof entry.nonce === "number" ? entry.nonce : 0;
		result.push({ address, chainId, nonce });
	}
	return result;
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

	const authorizationList = parseAuthorizationListField(tx.authorizationList);

	return {
		to,
		from,
		data,
		value: value === null ? undefined : value.toString(),
		chain: chainId === null ? undefined : chainId.toString(),
		authorizationList: authorizationList.length > 0 ? authorizationList : undefined,
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
		const serializedTransaction = serializeTransaction(parsed);
		const from = await recoverTransactionAddress({ serializedTransaction });
		const value = parsed.value ?? 0n;
		const data = typeof parsed.data === "string" ? parsed.data : "0x";
		const chainId = parsed.chainId;

		// Extract EIP-7702 authorization list if present
		const authorizationList = extractAuthorizationListFromParsedTx(parsed);

		return {
			to,
			from,
			data,
			value: value.toString(),
			chain: chainId === undefined ? undefined : chainId.toString(),
			authorizationList: authorizationList.length > 0 ? authorizationList : undefined,
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

const PROMPT_TIMEOUT_MS = 60_000;

async function promptYesNo(
	question: string,
	options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<boolean> {
	const timeoutMs = options?.timeoutMs ?? PROMPT_TIMEOUT_MS;
	if (options?.signal?.aborted) return false;
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	try {
		const answer = await new Promise<string>((resolve) => {
			const onAbort = () => {
				resolve("");
				rl.close();
			};

			timeoutId = setTimeout(() => {
				process.stdout.write("\nPrompt timed out — defaulting to block.\n");
				resolve("");
				rl.close();
			}, timeoutMs);

			rl.on("close", () => resolve(""));

			if (options?.signal) {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}

			rl.question(question, (value) => {
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
				resolve(value);
			});
		});
		return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
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

function applyUpstreamRpcOverrides(options: {
	config: Config;
	chain: Chain;
	upstreamUrl: string;
}): Config {
	const upstreamUrl = options.upstreamUrl;
	const rpcUrls: Partial<Record<Chain, string>> = {
		...(options.config.rpcUrls ?? {}),
		[options.chain]: options.config.rpcUrls?.[options.chain] ?? upstreamUrl,
	};

	const baseSimulation = options.config.simulation;
	const simulation = baseSimulation
		? {
				...baseSimulation,
				rpcUrl: baseSimulation.rpcUrl ?? upstreamUrl,
			}
		: { rpcUrl: upstreamUrl };

	return {
		...options.config,
		rpcUrls,
		simulation,
	};
}

export type RecordingStatus = "pending" | "forwarded" | "blocked" | "error" | "aborted";

export interface RecordingHandle {
	dir: string;
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

async function initRecording(options: {
	recordDir: string;
	chain: Chain;
	method: string;
	calldata: CalldataInput;
	rpcRequest: JsonRpcRequest;
	quiet?: boolean;
}): Promise<RecordingHandle | null> {
	try {
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
			status: "pending" as RecordingStatus,
		};

		await Bun.write(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
		await Bun.write(path.join(dir, "rpc.json"), JSON.stringify(options.rpcRequest, null, 2));
		await Bun.write(path.join(dir, "calldata.json"), JSON.stringify(options.calldata, null, 2));

		return { dir };
	} catch (error) {
		if (!options.quiet) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Warning: failed to write early recording: ${message}\n`);
		}
		return null;
	}
}

async function finalizeRecording(options: {
	handle: RecordingHandle;
	outcome?: ProxyScanOutcome;
	action?: RiskAction;
	status: RecordingStatus;
	quiet?: boolean;
}): Promise<void> {
	try {
		const metaPath = path.join(options.handle.dir, "meta.json");
		const existingRaw = await Bun.file(metaPath).text();
		const existing: unknown = JSON.parse(existingRaw);
		if (!isRecord(existing)) return;

		const updated: Record<string, unknown> = {
			...existing,
			status: options.status,
			completedAt: new Date().toISOString(),
		};
		if (options.action !== undefined) {
			updated.action = options.action;
		}
		if (options.outcome) {
			updated.recommendation = options.outcome.recommendation;
			updated.simulationSuccess = options.outcome.simulationSuccess;
		}

		await Bun.write(metaPath, JSON.stringify(updated, null, 2));

		if (options.outcome?.response) {
			await Bun.write(
				path.join(options.handle.dir, "analyzeResponse.json"),
				JSON.stringify(options.outcome.response, null, 2),
			);
		}
		if (options.outcome?.renderedText) {
			await Bun.write(path.join(options.handle.dir, "rendered.txt"), options.outcome.renderedText);
		}
	} catch (error) {
		if (!options.quiet) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Warning: failed to finalize recording: ${message}\n`);
		}
	}
}

async function defaultScanFn(
	input: ScanInput,
	options: {
		chain: Chain;
		config: Config;
		quiet: boolean;
		timings: TimingStore;
		offline?: boolean;
	},
): Promise<ProxyScanOutcome> {
	const providerStarts = new Map<string, number>();
	const baseProgress = options.quiet
		? undefined
		: createProgressRenderer(Boolean(process.stdout.isTTY));

	const progress = (event: {
		provider: string;
		status: "start" | "success" | "error";
		message?: string;
	}) => {
		if (event.status === "start") {
			providerStarts.set(event.provider, nowMs());
		} else {
			const started = providerStarts.get(event.provider);
			if (started !== undefined) {
				options.timings.add(`provider.${event.provider}`, nowMs() - started);
				providerStarts.delete(event.provider);
			}
		}
		baseProgress?.(event);
	};

	const scanStarted = nowMs();
	const { analysis, response } = await scanWithAnalysis(input, {
		chain: options.chain,
		config: options.config,
		offline: options.offline,
		progress,
		timings: options.timings,
	});
	options.timings.add("proxy.scan", nowMs() - scanStarted);

	let renderedText: string | undefined;
	if (!options.quiet) {
		const renderStarted = nowMs();
		const scanLabel = input.calldata ? "Transaction" : "Address";
		renderedText = `${renderHeading(`${scanLabel} scan on ${options.chain}`)}\n\n${renderResultBox(
			analysis,
			{
				hasCalldata: Boolean(input.calldata),
				sender: input.calldata?.from,
			},
		)}\n`;
		options.timings.add("proxy.render", nowMs() - renderStarted);
	}

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
	const showTimings = options.showTimings ?? false;
	const exitOnOnce = options.exitOnOnce ?? true;
	const recordDir =
		typeof options.recordDir === "string" && options.recordDir.trim().length > 0
			? options.recordDir.trim()
			: null;
	const configPromise = options.config ? Promise.resolve(options.config) : loadConfig();
	let upstreamChainId: string | null = null;
	let upstreamChainIdPromise: Promise<string | null> | null = null;
	let interceptedHandled = 0;
	let scanQueue: Promise<void> = Promise.resolve();

	if (!options.scanFn) {
		void (async () => {
			const config = await configPromise;
			const detectedChainId = await getUpstreamChainId(options.upstreamUrl);
			if (upstreamChainId === null) {
				upstreamChainId = detectedChainId;
			}

			const chain = resolveChainFromInputs({
				upstreamChainId,
				requestedChain: options.chain,
				calldataChain: undefined,
			});
			if (!chain) return;

			const scanConfig = applyUpstreamRpcOverrides({
				config,
				chain,
				upstreamUrl: options.upstreamUrl,
			});
			const instance = await getAnvilClient(chain, scanConfig, { offline: options.offline });
			await instance.runExclusive(async () => {
				await instance.resetFork();
			});
		})().catch(() => undefined);
	}

	const server = Bun.serve({
		hostname: options.hostname ?? "127.0.0.1",
		port: options.port ?? 8545,
		fetch: async (request: Request): Promise<Response> => {
			if (request.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders() });
			}
			if (request.method === "GET") {
				return jsonResponse({ ok: true, name: "assay-jsonrpc-proxy" }, 200);
			}
			if (request.method !== "POST") {
				return jsonResponse(jsonRpcError(null, -32601, "Method not allowed"), 405);
			}

			const parseStarted = nowMs();
			let rawBody: string;
			let body: unknown;
			try {
				rawBody = await request.text();
				body = JSON.parse(rawBody);
			} catch {
				return jsonResponse(jsonRpcError(null, -32700, "Parse error"), 400);
			}
			const httpParseMs = nowMs() - parseStarted;
			let handledInterceptableSend = false;

			const handleSingle = async (
				entry: unknown,
				requestSignal?: AbortSignal,
			): Promise<JsonRpcSuccess | JsonRpcFailure | null> => {
				if (!isJsonRpcRequest(entry)) {
					return jsonRpcError(null, -32600, "Invalid Request");
				}
				const idPresent = "id" in entry;
				const id: JsonRpcId = idPresent ? (entry.id ?? null) : null;
				const isNotification = !idPresent;

				const isSendTransactionMethod =
					entry.method === "eth_sendTransaction" || entry.method === "eth_sendRawTransaction";
				const isTypedDataMethod = entry.method === "eth_signTypedData_v4";
				const isInterceptable = isSendTransactionMethod || isTypedDataMethod;
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

				handledInterceptableSend = true;
				const entryStarted = nowMs();
				const timings = new TimingStore();
				timings.add("proxy.httpParse", httpParseMs);
				const config = await configPromise;

				let recording: RecordingHandle | null = null;
				let outcome: ProxyScanOutcome;
				let allowlist: AllowlistEvaluation = {
					enabled: false,
					violations: [],
					unknownApprovalSpenders: false,
				};
				let scanErrored = false;

				if (isSendTransactionMethod) {
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
						if (!upstreamChainIdPromise) {
							upstreamChainIdPromise = getUpstreamChainId(options.upstreamUrl);
						}
						upstreamChainId = await upstreamChainIdPromise;
					}

					const chain = resolveChainFromInputs({
						upstreamChainId,
						requestedChain: options.chain,
						calldataChain: calldata.chain,
					});
					if (!chain) {
						return isNotification ? null : jsonRpcError(id, -32602, "Unable to resolve chain");
					}

					if (recordDir) {
						recording = await initRecording({
							recordDir,
							chain,
							method: entry.method,
							calldata,
							rpcRequest: entry,
							quiet,
						});
					}

					const scanConfig = applyUpstreamRpcOverrides({
						config,
						chain,
						upstreamUrl: options.upstreamUrl,
					});

					const input: ScanInput = {
						calldata: { ...calldata, chain: calldata.chain ?? upstreamChainId ?? undefined },
					};
					const validated = scanInputSchema.safeParse(input);
					if (!validated.success) {
						return isNotification ? null : jsonRpcError(id, -32602, "Invalid transaction fields");
					}

					try {
						const scanFn = options.scanFn
							? options.scanFn
							: async (
									scanInput: ScanInput,
									ctx: {
										chain: Chain;
										config: Config;
										quiet?: boolean;
										timings?: TimingStore;
										offline?: boolean;
									},
								) =>
									await defaultScanFn(scanInput, {
										...ctx,
										quiet: ctx.quiet ?? quiet,
										timings: ctx.timings ?? timings,
										offline: ctx.offline ?? options.offline,
									});

						const queuedAt = nowMs();
						const queued = scanQueue.then(async () => {
							timings.add("proxy.queueWait", nowMs() - queuedAt);
							return await scanFn(validated.data, {
								chain,
								config: scanConfig,
								quiet,
								timings,
								offline: options.offline,
							});
						});
						scanQueue = queued.then(
							() => undefined,
							() => undefined,
						);

						outcome = await queued;
					} catch (error) {
						scanErrored = true;
						const message = error instanceof Error ? error.message : "scan failed";
						outcome = {
							recommendation: "caution",
							simulationSuccess: false,
							renderedText: quiet ? undefined : `Scan failed: ${message}`,
						};
					}

					allowlist = evaluateAllowlist({ calldata, config: scanConfig, outcome });
				} else {
					const typedDataPayload = extractSignTypedDataV4Payload(entry.params);
					if (!typedDataPayload) {
						if (isNotification) return null;
						return jsonRpcError(id, -32602, "Invalid params for eth_signTypedData_v4");
					}

					const assessment = analyzeSignTypedDataV4Risk(typedDataPayload);
					const resolvedChain = resolveChainFromInputs({
						upstreamChainId,
						requestedChain: options.chain,
						calldataChain: assessment.chainId,
					});

					outcome = {
						recommendation: assessment.recommendation,
						simulationSuccess: true,
						renderedText: quiet
							? undefined
							: renderTypedDataAssessment({ assessment, resolvedChain }),
						blockData: buildTypedDataBlockData(assessment),
					};
					allowlist = evaluateTypedDataAllowlist({ config, assessment });
				}

				if (requestSignal?.aborted) {
					if (!quiet) {
						process.stderr.write("Client disconnected during analysis. Blocking by default.\n");
					}
					if (recording) {
						await finalizeRecording({
							handle: recording,
							outcome,
							action: "block",
							status: "aborted",
							quiet,
						});
					}
					return isNotification
						? null
						: jsonRpcError(
								id,
								4001,
								"Transaction blocked by assay",
								buildProxyBlockData(outcome, allowlist),
							);
				}

				timings.add("proxy.total", nowMs() - entryStarted);

				if (!quiet && outcome.renderedText) {
					process.stdout.write(`${outcome.renderedText}\n`);
				}
				if (!quiet && showTimings) {
					process.stdout.write(`${timings.toLogLine(`timing ${entry.method}`)}\n`);
				}

				if (!quiet && allowlist.enabled) {
					if (allowlist.violations.length > 0) {
						process.stdout.write(
							`Allowlist violations: ${allowlist.violations
								.map((v) => `${v.kind}:${shortenHexAddress(v.address)} (${v.source})`)
								.join(", ")}\n`,
						);
					} else if (allowlist.unknownApprovalSpenders) {
						process.stdout.write(
							isTypedDataMethod
								? "Allowlist note: typed-data spender/operator could not be determined\n"
								: "Allowlist note: approval spender/operator could not be determined (simulation failed)\n",
						);
					}
				}
				if (allowlist.violations.length > 0) {
					outcome = {
						...outcome,
						recommendation: ensureRecommendationAtLeast(outcome.recommendation, "warning"),
					};
				}

				const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
				let action = decideRiskAction({
					recommendation: outcome.recommendation,
					simulationSuccess: outcome.simulationSuccess,
					policy,
					isInteractive,
				});

				if (allowlist.violations.length > 0 && action === "forward") {
					action = isInteractive ? policy.onRisk : "block";
				}

				if (action === "prompt") {
					const allowlistSummary = formatAllowlistSummary(allowlist);
					const ok = await promptYesNo(
						`Forward transaction anyway? (recommendation=${outcome.recommendation}, simulation=${
							outcome.simulationSuccess ? "ok" : "failed"
						}${allowlistSummary}) [y/N] `,
						{ signal: requestSignal },
					);
					if (!ok) {
						if (!quiet) {
							process.stdout.write("Blocked transaction.\n");
						}
						if (recording) {
							await finalizeRecording({
								handle: recording,
								outcome,
								action: "block",
								status: "blocked",
								quiet,
							});
						}
						if (isNotification) return null;
						return jsonRpcError(
							id,
							4001,
							"Transaction blocked by assay",
							buildProxyBlockData(outcome, allowlist),
						);
					}
				}

				if (action === "block") {
					if (!quiet) {
						process.stdout.write("Blocked transaction.\n");
					}
					if (recording) {
						await finalizeRecording({
							handle: recording,
							outcome,
							action: "block",
							status: "blocked",
							quiet,
						});
					}
					return isNotification
						? null
						: jsonRpcError(
								id,
								4001,
								"Transaction blocked by assay",
								buildProxyBlockData(outcome, allowlist),
							);
				}

				// Scan errored but action resolved to forward — mark recording as error.
				if (recording) {
					await finalizeRecording({
						handle: recording,
						outcome,
						action,
						status: scanErrored ? "error" : "forwarded",
						quiet,
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

			const requestSignal = request.signal;
			let responsePayload: unknown;
			if (Array.isArray(body)) {
				const responses: Array<JsonRpcSuccess | JsonRpcFailure> = [];
				for (const entry of body) {
					const res = await handleSingle(entry, requestSignal);
					if (!res) continue;
					responses.push(res);
				}
				if (responses.length === 0) {
					return new Response(null, { status: 204, headers: corsHeaders() });
				}
				responsePayload = responses;
			} else {
				const res = await handleSingle(body, requestSignal);
				if (!res) {
					return new Response(null, { status: 204, headers: corsHeaders() });
				}
				responsePayload = res;
			}

			if (handledInterceptableSend) {
				interceptedHandled += 1;
			}
			if (options.once && interceptedHandled >= 1) {
				// Allow the response to flush before stopping the server.
				setTimeout(() => {
					server.stop(true);
					if (exitOnOnce) {
						process.exit(0);
					}
				}, 0);
			}

			return jsonResponse(responsePayload, 200);
		},
	});

	return server;
}
