import { z } from "zod";

const recommendationSchema = z.enum(["ok", "caution", "warning", "danger"]);

export const telemetrySeverityBucketSchema = z.enum(["SAFE", "CAUTION", "WARNING", "BLOCK"]);

const chainSchema = z.enum(["ethereum", "base", "arbitrum", "optimism", "polygon", "unknown"]);

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const telemetrySourceSchema = z.enum(["proxy", "cli", "server", "sdk_viem"]);

const telemetryBaseSchema = z
	.object({
		eventVersion: z.literal(1),
		eventId: z.string().uuid(),
		ts: z.string().datetime(),
		sessionId: z.string().uuid(),
		correlationId: z.string().uuid(),
		source: telemetrySourceSchema,
		installId: hashSchema,
		actorWalletHash: hashSchema.nullable(),
		chain: chainSchema,
	})
	.strict();

const scanStartedSchema = telemetryBaseSchema
	.extend({
		event: z.literal("scan_started"),
		inputKind: z.enum(["address", "calldata", "typed_data"]),
		method: z.enum([
			"assay_scan",
			"eth_sendTransaction",
			"eth_sendRawTransaction",
			"eth_signTypedData_v4",
		]),
		mode: z.enum(["default", "offline"]),
		threshold: recommendationSchema,
		txFingerprint: hashSchema.nullable(),
		actionFingerprint: hashSchema.nullable(),
	})
	.strict();

const scanResultSchema = telemetryBaseSchema
	.extend({
		event: z.literal("scan_result"),
		requestId: z.string().uuid().nullable(),
		recommendation: recommendationSchema,
		severityBucket: telemetrySeverityBucketSchema,
		simulationStatus: z.enum(["success", "failed", "not_run"]),
		findingCodes: z.array(z.string().min(1)).max(5),
		latencyMs: z.number().int().min(0),
	})
	.strict();

const userActionOutcomeSchema = telemetryBaseSchema
	.extend({
		event: z.literal("user_action_outcome"),
		requestId: z.string().uuid().nullable(),
		recommendation: recommendationSchema,
		severityBucket: telemetrySeverityBucketSchema,
		decision: z.enum([
			"forwarded",
			"blocked_user",
			"blocked_policy",
			"blocked_simulation",
			"blocked_disconnect",
			"error",
		]),
		prompted: z.boolean(),
		promptResponse: z.enum(["accept", "deny", "timeout", "na"]),
		upstreamForwarded: z.boolean(),
		txFingerprint: hashSchema.nullable(),
		actionFingerprint: hashSchema.nullable(),
	})
	.strict();

export const telemetryEventSchema = z.discriminatedUnion("event", [
	scanStartedSchema,
	scanResultSchema,
	userActionOutcomeSchema,
]);

export type TelemetrySource = z.infer<typeof telemetrySourceSchema>;
export type TelemetrySeverityBucket = z.infer<typeof telemetrySeverityBucketSchema>;
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
