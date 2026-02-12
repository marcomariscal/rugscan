import type { Transport } from "viem";
import { parseTransaction, recoverTransactionAddress, serializeTransaction } from "viem";
import { renderResultBox } from "../cli/ui";
import { type ScanOptions, scanWithAnalysis } from "../scan";
import type { AnalyzeResponse, AuthorizationEntry, CalldataInput, ScanInput } from "../schema";
import { scanInputSchema } from "../schema";
import type { AnalysisResult, Config, Recommendation } from "../types";

const RECOMMENDATION_ORDER: Recommendation[] = ["ok", "caution", "warning", "danger"];

type SerializedTransaction = Parameters<typeof parseTransaction>[0];

function recommendationAtLeast(actual: Recommendation, threshold: Recommendation): boolean {
	const actualIndex = RECOMMENDATION_ORDER.indexOf(actual);
	const thresholdIndex = RECOMMENDATION_ORDER.indexOf(threshold);
	// If we somehow get an unknown recommendation, treat it as risky.
	if (actualIndex === -1 || thresholdIndex === -1) return true;
	return actualIndex >= thresholdIndex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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

function isSerializedTransaction(value: unknown): value is SerializedTransaction {
	if (typeof value !== "string") return false;
	if (!/^0x[0-9a-fA-F]*$/.test(value)) return false;
	// Must be even length (each byte = 2 hex chars)
	if ((value.length - 2) % 2 !== 0) return false;
	return value !== "0x";
}

function isAddress(value: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parseAuthorizationListField(value: unknown): AuthorizationEntry[] {
	if (!Array.isArray(value)) return [];
	const result: AuthorizationEntry[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const address = typeof entry.address === "string" ? entry.address : null;
		if (!address || !isAddress(address)) continue;

		const parsedChainId = parseQuantity(entry.chainId);
		const parsedNonce = parseQuantity(entry.nonce);
		const chainId =
			typeof entry.chainId === "number"
				? entry.chainId
				: parsedChainId === null
					? 0
					: Number(parsedChainId);
		const nonce =
			typeof entry.nonce === "number"
				? entry.nonce
				: parsedNonce === null
					? 0
					: Number(parsedNonce);
		result.push({ address, chainId, nonce });
	}
	return result;
}

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

function extractSendTransactionCalldata(params: unknown): CalldataInput | null {
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

async function extractSendRawTransactionCalldata(params: unknown): Promise<CalldataInput | null> {
	if (!Array.isArray(params) || params.length < 1) return null;
	const raw = params[0];
	if (!isSerializedTransaction(raw)) return null;

	try {
		const parsed = parseTransaction(raw);
		const to = typeof parsed.to === "string" ? parsed.to : undefined;
		if (!to) return null;
		const serializedTransaction = serializeTransaction(parsed);
		const from = await recoverTransactionAddress({ serializedTransaction });
		const value = parsed.value ?? 0n;
		const data = typeof parsed.data === "string" ? parsed.data : "0x";
		const chainId = parsed.chainId;
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

export type AssayViemOnRisk = (event: {
	method: "eth_sendTransaction" | "eth_sendRawTransaction";
	analysis: AnalysisResult;
	response: AnalyzeResponse;
	renderedSummary: string;
	recommendation: Recommendation;
	simulationSuccess: boolean;
}) => void;

export type AssayScanFn = (
	input: ScanInput,
	options?: ScanOptions,
) => Promise<{ analysis: AnalysisResult; response: AnalyzeResponse }>;

export type AssayTransportErrorReason =
	| "risky"
	| "simulation_failed"
	| "analysis_error"
	| "invalid_params";

export class AssayTransportError extends Error {
	reason: AssayTransportErrorReason;
	method: string;
	threshold?: Recommendation;
	recommendation?: Recommendation;
	simulationSuccess?: boolean;
	analyzeResponse?: AnalyzeResponse;
	renderedSummary?: string;

	constructor(options: {
		message: string;
		reason: AssayTransportErrorReason;
		method: string;
		threshold?: Recommendation;
		recommendation?: Recommendation;
		simulationSuccess?: boolean;
		analyzeResponse?: AnalyzeResponse;
		renderedSummary?: string;
		cause?: unknown;
	}) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AssayTransportError";
		this.reason = options.reason;
		this.method = options.method;
		this.threshold = options.threshold;
		this.recommendation = options.recommendation;
		this.simulationSuccess = options.simulationSuccess;
		this.analyzeResponse = options.analyzeResponse;
		this.renderedSummary = options.renderedSummary;
	}
}

export interface AssayViemTransportOptions {
	upstream: Transport;
	config: Config;
	threshold: Recommendation;
	onRisk?: AssayViemOnRisk;
	scanFn?: AssayScanFn;
}

export function createAssayViemTransport(options: AssayViemTransportOptions): Transport {
	return (params) => {
		const upstream = options.upstream(params);
		const upstreamRequest = upstream.request;

		const request = (async (args, requestOptions) => {
			const method = args.method;
			if (method !== "eth_sendTransaction" && method !== "eth_sendRawTransaction") {
				return await upstreamRequest(args, requestOptions);
			}

			const chainId = typeof params.chain?.id === "number" ? `${params.chain.id}` : undefined;
			const requestId = typeof requestOptions?.uid === "string" ? requestOptions.uid : undefined;

			const extracted =
				method === "eth_sendTransaction"
					? extractSendTransactionCalldata(args.params)
					: await extractSendRawTransactionCalldata(args.params);
			if (!extracted) {
				throw new AssayTransportError({
					message: `Assay blocked: invalid params for ${method}`,
					reason: "invalid_params",
					method,
				});
			}

			const input: ScanInput = {
				calldata: {
					...extracted,
					chain: extracted.chain ?? chainId,
				},
			};
			const validated = scanInputSchema.safeParse(input);
			if (!validated.success) {
				throw new AssayTransportError({
					message: `Assay blocked: invalid transaction fields for ${method}`,
					reason: "invalid_params",
					method,
				});
			}

			const scanFn = options.scanFn ?? scanWithAnalysis;
			let analysis: AnalysisResult;
			let response: AnalyzeResponse;
			try {
				const result = await scanFn(validated.data, {
					chain: validated.data.calldata?.chain ?? chainId,
					config: options.config,
					requestId,
				});
				analysis = result.analysis;
				response = result.response;
			} catch (error) {
				const message = error instanceof Error ? error.message : "analysis failed";
				throw new AssayTransportError({
					message: `Assay blocked: ${message}`,
					reason: "analysis_error",
					method,
					cause: error,
				});
			}

			const recommendation = analysis.recommendation;
			const simulationSuccess = analysis.simulation?.success ?? false;
			const isRisky = recommendationAtLeast(recommendation, options.threshold);
			if (isRisky || !simulationSuccess) {
				const renderedSummary = renderResultBox(analysis, {
					hasCalldata: true,
				});

				options.onRisk?.({
					method,
					analysis,
					response,
					renderedSummary,
					recommendation,
					simulationSuccess,
				});

				throw new AssayTransportError({
					message: `Assay blocked transaction (${method})`,
					reason: !simulationSuccess ? "simulation_failed" : "risky",
					method,
					threshold: options.threshold,
					recommendation,
					simulationSuccess,
					analyzeResponse: response,
					renderedSummary,
				});
			}

			return await upstreamRequest(args, requestOptions);
		}) satisfies typeof upstreamRequest;

		return {
			...upstream,
			request,
		};
	};
}
