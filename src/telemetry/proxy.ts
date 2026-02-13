import type { Recommendation } from "../types";
import { isTelemetryEnabled } from "./gate";
import {
	buildActionFingerprint,
	buildTransactionFingerprint,
	hashAddress,
	hashWithSalt,
	resolveTelemetrySalt,
} from "./hash";
import type { TelemetryEvent, TelemetrySeverityBucket, TelemetrySource } from "./schema";
import { createAppendOnlyTelemetryWriter, type TelemetryWriter } from "./writer";

type TelemetryChain = "ethereum" | "base" | "arbitrum" | "optimism" | "polygon" | "unknown";

export type TelemetryInputKind = "address" | "calldata" | "typed_data";

export type TelemetryDecision =
	| "forwarded"
	| "blocked_user"
	| "blocked_policy"
	| "blocked_simulation"
	| "blocked_disconnect"
	| "error";

export type TelemetryPromptResponse = "accept" | "deny" | "timeout" | "na";

interface ProxyTelemetryBaseInput {
	correlationId: string;
	chain?: string | null;
	actorAddress?: string;
	to?: string;
	data?: string;
	value?: string;
}

export interface ProxyScanStartedInput extends ProxyTelemetryBaseInput {
	method: "assay_scan" | "eth_sendTransaction" | "eth_sendRawTransaction" | "eth_signTypedData_v4";
	inputKind: TelemetryInputKind;
	threshold: Recommendation;
	offline: boolean;
}

export interface ProxyScanResultInput extends ProxyTelemetryBaseInput {
	requestId?: string;
	recommendation: Recommendation;
	simulationStatus: "success" | "failed" | "not_run";
	findingCodes: string[];
	latencyMs: number;
}

export interface ProxyUserActionOutcomeInput extends ProxyTelemetryBaseInput {
	requestId?: string;
	recommendation: Recommendation;
	decision: TelemetryDecision;
	prompted: boolean;
	promptResponse: TelemetryPromptResponse;
	upstreamForwarded: boolean;
}

export interface ProxyTelemetry {
	emitScanStarted(input: ProxyScanStartedInput): void;
	emitScanResult(input: ProxyScanResultInput): void;
	emitUserActionOutcome(input: ProxyUserActionOutcomeInput): void;
	flush(): Promise<void>;
}

export interface ProxyTelemetryOptions {
	env?: NodeJS.ProcessEnv;
	source?: TelemetrySource;
	sessionId?: string;
	now?: () => Date;
	writer?: TelemetryWriter;
	onError?: (error: unknown) => void;
}

function normalizeChain(chain: string | null | undefined): TelemetryChain {
	switch (chain) {
		case "ethereum":
		case "base":
		case "arbitrum":
		case "optimism":
		case "polygon":
			return chain;
		default:
			return "unknown";
	}
}

function severityBucket(recommendation: Recommendation): TelemetrySeverityBucket {
	switch (recommendation) {
		case "ok":
			return "SAFE";
		case "caution":
			return "CAUTION";
		case "warning":
			return "WARNING";
		case "danger":
			return "BLOCK";
	}
}

function toNullableUuid(value: string | undefined): string | null {
	if (!value) return null;
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
		return value;
	}
	return null;
}

interface EmitContext {
	salt: string;
	installId: string;
}

export function createProxyTelemetry(options?: ProxyTelemetryOptions): ProxyTelemetry {
	const enabled = isTelemetryEnabled(options?.env);
	const writer = options?.writer ?? createAppendOnlyTelemetryWriter({ onError: options?.onError });
	const now = options?.now ?? (() => new Date());
	const source = options?.source ?? "proxy";
	const sessionId = options?.sessionId ?? crypto.randomUUID();
	const saltPromise = enabled ? resolveTelemetrySalt({ env: options?.env }) : Promise.resolve("");

	function buildBaseEvent(
		input: ProxyTelemetryBaseInput,
		ctx: EmitContext,
	): {
		eventVersion: 1;
		eventId: string;
		ts: string;
		sessionId: string;
		correlationId: string;
		source: TelemetrySource;
		installId: string;
		actorWalletHash: string | null;
		chain: TelemetryChain;
	} {
		return {
			eventVersion: 1,
			eventId: crypto.randomUUID(),
			ts: now().toISOString(),
			sessionId,
			correlationId: input.correlationId,
			source,
			installId: ctx.installId,
			actorWalletHash: hashAddress(input.actorAddress, ctx.salt),
			chain: normalizeChain(input.chain),
		};
	}

	function emit(factory: (ctx: EmitContext) => TelemetryEvent) {
		if (!enabled) return;
		void saltPromise
			.then((salt) => {
				const ctx: EmitContext = {
					salt,
					installId: hashWithSalt("install", salt),
				};
				const event = factory(ctx);
				writer.write(event);
			})
			.catch((error) => {
				options?.onError?.(error);
			});
	}

	return {
		emitScanStarted(input) {
			emit((ctx) => ({
				...buildBaseEvent(input, ctx),
				event: "scan_started",
				inputKind: input.inputKind,
				method: input.method,
				mode: input.offline ? "offline" : "default",
				threshold: input.threshold,
				txFingerprint: buildTransactionFingerprint({
					chain: normalizeChain(input.chain),
					to: input.to,
					data: input.data,
					value: input.value,
					salt: ctx.salt,
				}),
				actionFingerprint: buildActionFingerprint({
					chain: normalizeChain(input.chain),
					to: input.to,
					data: input.data,
					salt: ctx.salt,
				}),
			}));
		},
		emitScanResult(input) {
			emit((ctx) => ({
				...buildBaseEvent(input, ctx),
				event: "scan_result",
				requestId: toNullableUuid(input.requestId),
				recommendation: input.recommendation,
				severityBucket: severityBucket(input.recommendation),
				simulationStatus: input.simulationStatus,
				findingCodes: input.findingCodes.slice(0, 5),
				latencyMs: Math.max(0, Math.trunc(input.latencyMs)),
			}));
		},
		emitUserActionOutcome(input) {
			emit((ctx) => ({
				...buildBaseEvent(input, ctx),
				event: "user_action_outcome",
				requestId: toNullableUuid(input.requestId),
				recommendation: input.recommendation,
				severityBucket: severityBucket(input.recommendation),
				decision: input.decision,
				prompted: input.prompted,
				promptResponse: input.promptResponse,
				upstreamForwarded: input.upstreamForwarded,
				txFingerprint: buildTransactionFingerprint({
					chain: normalizeChain(input.chain),
					to: input.to,
					data: input.data,
					value: input.value,
					salt: ctx.salt,
				}),
				actionFingerprint: buildActionFingerprint({
					chain: normalizeChain(input.chain),
					to: input.to,
					data: input.data,
					salt: ctx.salt,
				}),
			}));
		},
		async flush() {
			if (!enabled) return;
			await saltPromise.catch(() => undefined);
			await writer.flush();
		},
	};
}
