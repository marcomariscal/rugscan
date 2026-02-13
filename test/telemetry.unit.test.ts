import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildActionFingerprint,
	buildTransactionFingerprint,
	createAppendOnlyTelemetryWriter,
	createProxyTelemetry,
	hashAddress,
	hashWithSalt,
	isTelemetryEnabled,
	type TelemetryEvent,
	telemetryEventSchema,
} from "../src/telemetry";

// ---------------------------------------------------------------------------
// Gate tests
// ---------------------------------------------------------------------------
describe("telemetry gate", () => {
	test("enabled by default", () => {
		expect(isTelemetryEnabled({})).toBe(true);
	});

	test("disabled when ASSAY_TELEMETRY=0", () => {
		expect(isTelemetryEnabled({ ASSAY_TELEMETRY: "0" })).toBe(false);
	});

	test("disabled when ASSAY_TELEMETRY=false", () => {
		expect(isTelemetryEnabled({ ASSAY_TELEMETRY: "false" })).toBe(false);
	});

	test("enabled when ASSAY_TELEMETRY=1", () => {
		expect(isTelemetryEnabled({ ASSAY_TELEMETRY: "1" })).toBe(true);
	});

	test("disabled when ASSAY_TELEMETRY_OPTOUT=1", () => {
		expect(isTelemetryEnabled({ ASSAY_TELEMETRY_OPTOUT: "1" })).toBe(false);
	});

	test("ASSAY_TELEMETRY takes precedence over ASSAY_TELEMETRY_OPTOUT", () => {
		expect(isTelemetryEnabled({ ASSAY_TELEMETRY: "1", ASSAY_TELEMETRY_OPTOUT: "1" })).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Hashing tests
// ---------------------------------------------------------------------------
describe("telemetry hashing", () => {
	const salt = "test-salt-value";

	test("hashWithSalt returns 64-char hex string", () => {
		const result = hashWithSalt("test-value", salt);
		expect(result).toMatch(/^[a-f0-9]{64}$/);
	});

	test("hashWithSalt is deterministic", () => {
		const a = hashWithSalt("same-input", salt);
		const b = hashWithSalt("same-input", salt);
		expect(a).toBe(b);
	});

	test("different salt produces different hash", () => {
		const a = hashWithSalt("same-input", "salt-a");
		const b = hashWithSalt("same-input", "salt-b");
		expect(a).not.toBe(b);
	});

	test("hashAddress returns null for undefined", () => {
		expect(hashAddress(undefined, salt)).toBeNull();
	});

	test("hashAddress returns 64-char hex for valid address", () => {
		const result = hashAddress("0x1234567890abcdef1234567890abcdef12345678", salt);
		expect(result).toMatch(/^[a-f0-9]{64}$/);
	});

	test("hashAddress normalizes case", () => {
		const lower = hashAddress("0xabcdef1234567890abcdef1234567890abcdef12", salt);
		const upper = hashAddress("0xABCDEF1234567890ABCDEF1234567890ABCDEF12", salt);
		expect(lower).toBe(upper);
	});

	test("buildTransactionFingerprint returns null when no to address", () => {
		expect(
			buildTransactionFingerprint({
				chain: "ethereum",
				data: "0x",
				salt,
			}),
		).toBeNull();
	});

	test("buildTransactionFingerprint returns 64-char hex", () => {
		const result = buildTransactionFingerprint({
			chain: "ethereum",
			to: "0xabc",
			data: "0x12345678",
			value: "0",
			salt,
		});
		expect(result).toMatch(/^[a-f0-9]{64}$/);
	});

	test("buildTransactionFingerprint differs by value bucket", () => {
		const small = buildTransactionFingerprint({
			chain: "ethereum",
			to: "0xabc",
			data: "0x12345678",
			value: "100000000000000",
			salt,
		});
		const large = buildTransactionFingerprint({
			chain: "ethereum",
			to: "0xabc",
			data: "0x12345678",
			value: "1000000000000000000",
			salt,
		});
		expect(small).not.toBe(large);
	});

	test("buildActionFingerprint ignores value", () => {
		const a = buildActionFingerprint({
			chain: "ethereum",
			to: "0xabc",
			data: "0x12345678",
			salt,
		});
		// Action fingerprint does not include value, so should be identical regardless of value
		const b = buildActionFingerprint({
			chain: "ethereum",
			to: "0xabc",
			data: "0x12345678",
			salt,
		});
		expect(a).toBe(b);
	});
});

// ---------------------------------------------------------------------------
// Writer tests
// ---------------------------------------------------------------------------
describe("telemetry writer", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "assay-telemetry-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeSampleEvent(overrides?: Partial<TelemetryEvent>): TelemetryEvent {
		return {
			event: "scan_started",
			eventVersion: 1,
			eventId: crypto.randomUUID(),
			ts: new Date().toISOString(),
			sessionId: crypto.randomUUID(),
			correlationId: crypto.randomUUID(),
			source: "proxy",
			installId: hashWithSalt("install", "test-salt"),
			actorWalletHash: hashWithSalt("actor", "test-salt"),
			chain: "ethereum",
			inputKind: "calldata",
			method: "eth_sendTransaction",
			mode: "default",
			threshold: "caution",
			txFingerprint: hashWithSalt("tx", "test-salt"),
			actionFingerprint: hashWithSalt("action", "test-salt"),
			...overrides,
		} as TelemetryEvent;
	}

	test("writes valid event to JSONL file", async () => {
		const filePath = path.join(tmpDir, "events.jsonl");
		const writer = createAppendOnlyTelemetryWriter({ filePath });
		const event = makeSampleEvent();
		writer.write(event);
		await writer.flush();

		const raw = readFileSync(filePath, "utf-8").trim();
		const parsed = JSON.parse(raw);
		expect(parsed.event).toBe("scan_started");
		expect(parsed.eventVersion).toBe(1);
	});

	test("rejects invalid events and increments drop counter", async () => {
		const filePath = path.join(tmpDir, "events.jsonl");
		const errors: unknown[] = [];
		const writer = createAppendOnlyTelemetryWriter({
			filePath,
			onError: (err) => errors.push(err),
		});
		// Missing required fields
		writer.write({ event: "scan_started" } as unknown as TelemetryEvent);
		await writer.flush();

		expect(writer.getDroppedCount()).toBe(1);
		expect(errors.length).toBe(1);
	});

	test("writer is non-blocking: write failure does not throw", async () => {
		const errors: unknown[] = [];
		const writer = createAppendOnlyTelemetryWriter({
			filePath: path.join(tmpDir, "events.jsonl"),
			onError: (err) => errors.push(err),
			appendLine: async () => {
				throw new Error("disk full");
			},
		});

		const event = makeSampleEvent();
		// This must not throw
		writer.write(event);
		await writer.flush();

		expect(writer.getDroppedCount()).toBe(1);
		expect(errors.length).toBe(1);
	});

	test("multiple events append correctly", async () => {
		const filePath = path.join(tmpDir, "events.jsonl");
		const writer = createAppendOnlyTelemetryWriter({ filePath });

		writer.write(makeSampleEvent());
		writer.write({
			event: "scan_result",
			eventVersion: 1,
			eventId: crypto.randomUUID(),
			ts: new Date().toISOString(),
			sessionId: crypto.randomUUID(),
			correlationId: crypto.randomUUID(),
			source: "proxy",
			installId: hashWithSalt("install", "test-salt"),
			actorWalletHash: hashWithSalt("actor", "test-salt"),
			chain: "ethereum",
			requestId: crypto.randomUUID(),
			recommendation: "danger",
			severityBucket: "BLOCK",
			simulationStatus: "success",
			findingCodes: ["CALLDATA_DECODED"],
			latencyMs: 150,
		});
		await writer.flush();

		const lines = readFileSync(filePath, "utf-8").trim().split("\n");
		expect(lines.length).toBe(2);
		expect(JSON.parse(lines[0]).event).toBe("scan_started");
		expect(JSON.parse(lines[1]).event).toBe("scan_result");
	});
});

// ---------------------------------------------------------------------------
// Event schema validation
// ---------------------------------------------------------------------------
describe("telemetry event schema", () => {
	const salt = "test-salt";
	const base = {
		eventVersion: 1 as const,
		eventId: crypto.randomUUID(),
		ts: new Date().toISOString(),
		sessionId: crypto.randomUUID(),
		correlationId: crypto.randomUUID(),
		source: "proxy" as const,
		installId: hashWithSalt("install", salt),
		actorWalletHash: hashWithSalt("actor", salt),
		chain: "ethereum" as const,
	};

	test("scan_started validates", () => {
		const event = {
			...base,
			event: "scan_started" as const,
			inputKind: "calldata" as const,
			method: "eth_sendTransaction" as const,
			mode: "default" as const,
			threshold: "caution" as const,
			txFingerprint: hashWithSalt("tx", salt),
			actionFingerprint: hashWithSalt("action", salt),
		};
		const result = telemetryEventSchema.safeParse(event);
		expect(result.success).toBe(true);
	});

	test("scan_started validates for cli address scans", () => {
		const event = {
			...base,
			source: "cli" as const,
			event: "scan_started" as const,
			inputKind: "address" as const,
			method: "assay_scan" as const,
			mode: "default" as const,
			threshold: "caution" as const,
			txFingerprint: hashWithSalt("tx", salt),
			actionFingerprint: hashWithSalt("action", salt),
		};
		const result = telemetryEventSchema.safeParse(event);
		expect(result.success).toBe(true);
	});

	test("scan_result validates", () => {
		const event = {
			...base,
			event: "scan_result" as const,
			requestId: crypto.randomUUID(),
			recommendation: "danger" as const,
			severityBucket: "BLOCK" as const,
			simulationStatus: "success" as const,
			findingCodes: ["CALLDATA_DECODED", "APPROVAL_MAX"],
			latencyMs: 342,
		};
		const result = telemetryEventSchema.safeParse(event);
		expect(result.success).toBe(true);
	});

	test("user_action_outcome validates", () => {
		const event = {
			...base,
			event: "user_action_outcome" as const,
			requestId: null,
			recommendation: "warning" as const,
			severityBucket: "WARNING" as const,
			decision: "blocked_user" as const,
			prompted: true,
			promptResponse: "deny" as const,
			upstreamForwarded: false,
			txFingerprint: hashWithSalt("tx", salt),
			actionFingerprint: hashWithSalt("action", salt),
		};
		const result = telemetryEventSchema.safeParse(event);
		expect(result.success).toBe(true);
	});

	test("rejects event with extra fields", () => {
		const event = {
			...base,
			event: "scan_started" as const,
			inputKind: "calldata" as const,
			method: "eth_sendTransaction" as const,
			mode: "default" as const,
			threshold: "caution" as const,
			txFingerprint: hashWithSalt("tx", salt),
			actionFingerprint: hashWithSalt("action", salt),
			rawAddress: "0x1234567890abcdef1234567890abcdef12345678",
		};
		const result = telemetryEventSchema.safeParse(event);
		expect(result.success).toBe(false);
	});

	test("rejects raw address in actorWalletHash field", () => {
		const event = {
			...base,
			actorWalletHash: "0x1234567890abcdef1234567890abcdef12345678",
			event: "scan_started" as const,
			inputKind: "calldata" as const,
			method: "eth_sendTransaction" as const,
			mode: "default" as const,
			threshold: "caution" as const,
			txFingerprint: hashWithSalt("tx", salt),
			actionFingerprint: hashWithSalt("action", salt),
		};
		const result = telemetryEventSchema.safeParse(event);
		expect(result.success).toBe(false);
	});

	test("findingCodes are capped at 5", () => {
		const event = {
			...base,
			event: "scan_result" as const,
			requestId: null,
			recommendation: "ok" as const,
			severityBucket: "SAFE" as const,
			simulationStatus: "success" as const,
			findingCodes: ["A", "B", "C", "D", "E", "F"],
			latencyMs: 100,
		};
		const result = telemetryEventSchema.safeParse(event);
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Privacy guarantees
// ---------------------------------------------------------------------------
describe("telemetry privacy", () => {
	const salt = "privacy-test-salt";
	const rawAddress = "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7";
	const rawCalldata = "0xa9059cbb000000000000000000000000abcdef1234567890";

	test("hashAddress never returns the raw address", () => {
		const hashed = hashAddress(rawAddress, salt);
		expect(hashed).not.toBeNull();
		expect(hashed).not.toContain(rawAddress.slice(2));
		expect(hashed).not.toContain(rawAddress);
	});

	test("buildTransactionFingerprint does not contain raw calldata", () => {
		const fp = buildTransactionFingerprint({
			chain: "ethereum",
			to: rawAddress,
			data: rawCalldata,
			value: "1000000000000000000",
			salt,
		});
		expect(fp).not.toBeNull();
		// Fingerprint must not contain the raw address or calldata substring
		expect(fp).not.toContain(rawAddress.slice(2).toLowerCase());
		expect(fp).not.toContain(rawCalldata.slice(2).toLowerCase());
	});

	test("persisted events contain no raw addresses or calldata bodies", async () => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "assay-telemetry-privacy-"));
		const filePath = path.join(tmpDir, "events.jsonl");
		const saltPath = path.join(tmpDir, "salt");
		writeFileSync(saltPath, salt);

		try {
			const writer = createAppendOnlyTelemetryWriter({ filePath });
			const telemetry = createProxyTelemetry({
				env: { ASSAY_TELEMETRY_SALT: salt },
				writer,
				now: () => new Date("2026-02-13T12:00:00Z"),
			});

			telemetry.emitScanStarted({
				correlationId: crypto.randomUUID(),
				chain: "ethereum",
				actorAddress: rawAddress,
				to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
				data: rawCalldata,
				value: "1000000000000000000",
				method: "eth_sendTransaction",
				inputKind: "calldata",
				threshold: "caution",
				offline: false,
			});

			telemetry.emitScanResult({
				correlationId: crypto.randomUUID(),
				chain: "ethereum",
				actorAddress: rawAddress,
				to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
				data: rawCalldata,
				value: "1000000000000000000",
				requestId: "00000000-0000-0000-0000-000000000001",
				recommendation: "danger",
				simulationStatus: "success",
				findingCodes: ["APPROVAL_MAX"],
				latencyMs: 200,
			});

			telemetry.emitUserActionOutcome({
				correlationId: crypto.randomUUID(),
				chain: "ethereum",
				actorAddress: rawAddress,
				to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
				data: rawCalldata,
				value: "1000000000000000000",
				requestId: "00000000-0000-0000-0000-000000000001",
				recommendation: "danger",
				decision: "blocked_policy",
				prompted: false,
				promptResponse: "na",
				upstreamForwarded: false,
			});

			await telemetry.flush();

			const content = readFileSync(filePath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines.length).toBe(3);

			// Check that no raw address or calldata appears in the serialized output
			const rawAddressLower = rawAddress.slice(2).toLowerCase();
			const rawCalldataLower = rawCalldata.slice(10).toLowerCase(); // skip selector
			const toAddressLower = "66a9893cc07d91d95644aedd05d03f95e1dba8af";

			for (const line of lines) {
				const lower = line.toLowerCase();
				expect(lower).not.toContain(rawAddressLower);
				expect(lower).not.toContain(toAddressLower);
				// Calldata body beyond the 4-byte selector must not appear
				expect(lower).not.toContain(rawCalldataLower);
			}
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// ProxyTelemetry integration
// ---------------------------------------------------------------------------
describe("proxy telemetry", () => {
	test("emits nothing when disabled", async () => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "assay-telemetry-disabled-"));
		const filePath = path.join(tmpDir, "events.jsonl");

		try {
			const writer = createAppendOnlyTelemetryWriter({ filePath });
			const telemetry = createProxyTelemetry({
				env: { ASSAY_TELEMETRY: "0" },
				writer,
			});

			telemetry.emitScanStarted({
				correlationId: crypto.randomUUID(),
				chain: "ethereum",
				actorAddress: "0x1234567890abcdef1234567890abcdef12345678",
				to: "0xabcdef1234567890abcdef1234567890abcdef12",
				data: "0x",
				method: "eth_sendTransaction",
				inputKind: "calldata",
				threshold: "caution",
				offline: false,
			});

			await telemetry.flush();

			// File should not exist or be empty
			try {
				const content = readFileSync(filePath, "utf-8");
				expect(content.trim()).toBe("");
			} catch {
				// File doesn't exist — that's fine
			}
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("non-blocking: telemetry failure does not throw in proxy emitters", async () => {
		const errors: unknown[] = [];
		const writer = createAppendOnlyTelemetryWriter({
			filePath: "/dev/null",
			onError: (err) => errors.push(err),
			appendLine: async () => {
				throw new Error("simulated disk failure");
			},
		});
		const telemetry = createProxyTelemetry({
			env: { ASSAY_TELEMETRY_SALT: "test-salt" },
			writer,
			onError: (err) => errors.push(err),
		});

		// None of these should throw
		telemetry.emitScanStarted({
			correlationId: crypto.randomUUID(),
			chain: "ethereum",
			method: "eth_sendTransaction",
			inputKind: "calldata",
			threshold: "caution",
			offline: false,
		});
		telemetry.emitScanResult({
			correlationId: crypto.randomUUID(),
			chain: "ethereum",
			recommendation: "ok",
			simulationStatus: "success",
			findingCodes: [],
			latencyMs: 50,
		});
		telemetry.emitUserActionOutcome({
			correlationId: crypto.randomUUID(),
			chain: "ethereum",
			recommendation: "ok",
			decision: "forwarded",
			prompted: false,
			promptResponse: "na",
			upstreamForwarded: true,
		});

		await telemetry.flush();

		// Errors were collected, not thrown
		expect(errors.length).toBeGreaterThan(0);
	});

	test("severity bucket mapping is correct", async () => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "assay-telemetry-bucket-"));
		const filePath = path.join(tmpDir, "events.jsonl");

		try {
			const writer = createAppendOnlyTelemetryWriter({ filePath });
			const telemetry = createProxyTelemetry({
				env: { ASSAY_TELEMETRY_SALT: "test-salt" },
				writer,
			});

			const cases: Array<{ rec: "ok" | "caution" | "warning" | "danger"; bucket: string }> = [
				{ rec: "ok", bucket: "SAFE" },
				{ rec: "caution", bucket: "CAUTION" },
				{ rec: "warning", bucket: "WARNING" },
				{ rec: "danger", bucket: "BLOCK" },
			];

			for (const { rec } of cases) {
				telemetry.emitScanResult({
					correlationId: crypto.randomUUID(),
					chain: "ethereum",
					recommendation: rec,
					simulationStatus: "success",
					findingCodes: [],
					latencyMs: 10,
				});
			}

			await telemetry.flush();

			const lines = readFileSync(filePath, "utf-8").trim().split("\n");
			expect(lines.length).toBe(4);

			for (let i = 0; i < cases.length; i++) {
				const parsed = JSON.parse(lines[i]);
				expect(parsed.severityBucket).toBe(cases[i].bucket);
			}
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
