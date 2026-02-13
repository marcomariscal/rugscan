import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRollup } from "../scripts/rollup-prove-kill";

function hash(char: string): string {
	return char.repeat(64);
}

function makeBase(options: {
	ts: string;
	installId: string;
	correlationId: string;
	actorWalletHash?: string | null;
}): {
	eventVersion: 1;
	eventId: string;
	ts: string;
	sessionId: string;
	correlationId: string;
	source: "sdk_viem";
	installId: string;
	actorWalletHash: string | null;
	chain: "ethereum";
} {
	return {
		eventVersion: 1,
		eventId: crypto.randomUUID(),
		ts: options.ts,
		sessionId: crypto.randomUUID(),
		correlationId: options.correlationId,
		source: "sdk_viem",
		installId: options.installId,
		actorWalletHash: options.actorWalletHash ?? null,
		chain: "ethereum",
	};
}

function writeJsonl(filePath: string, events: unknown[]) {
	const content = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
	writeFileSync(filePath, content, "utf-8");
}

describe("rollup-prove-kill", () => {
	test("computes decision, repeat-use, and edit-retry metrics", async () => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "assay-rollup-"));
		const installA = hash("a");
		const installB = hash("b");
		const walletA = hash("c");
		const walletB = hash("d");

		try {
			const day1 = "2026-02-12";
			const day2 = "2026-02-13";
			writeJsonl(path.join(tmpDir, `${day1}.jsonl`), [
				{
					...makeBase({
						ts: "2026-02-12T11:00:00.000Z",
						installId: installA,
						correlationId: crypto.randomUUID(),
						actorWalletHash: walletA,
					}),
					event: "scan_started",
					inputKind: "calldata",
					method: "eth_sendTransaction",
					mode: "default",
					threshold: "caution",
					txFingerprint: hash("1"),
					actionFingerprint: hash("2"),
				},
			]);

			const blockedCorrelation = crypto.randomUUID();
			const retryCorrelation = crypto.randomUUID();
			const safeCorrelation = crypto.randomUUID();

			writeJsonl(path.join(tmpDir, `${day2}.jsonl`), [
				{
					...makeBase({
						ts: "2026-02-13T10:00:00.000Z",
						installId: installA,
						correlationId: blockedCorrelation,
						actorWalletHash: walletA,
					}),
					event: "scan_started",
					inputKind: "calldata",
					method: "eth_sendTransaction",
					mode: "default",
					threshold: "caution",
					txFingerprint: hash("3"),
					actionFingerprint: hash("4"),
				},
				{
					...makeBase({
						ts: "2026-02-13T10:00:05.000Z",
						installId: installA,
						correlationId: blockedCorrelation,
						actorWalletHash: walletA,
					}),
					event: "scan_result",
					requestId: crypto.randomUUID(),
					recommendation: "danger",
					severityBucket: "BLOCK",
					simulationStatus: "failed",
					findingCodes: ["APPROVAL_MAX"],
					latencyMs: 100,
				},
				{
					...makeBase({
						ts: "2026-02-13T10:00:06.000Z",
						installId: installA,
						correlationId: blockedCorrelation,
						actorWalletHash: walletA,
					}),
					event: "user_action_outcome",
					requestId: crypto.randomUUID(),
					recommendation: "danger",
					severityBucket: "BLOCK",
					decision: "blocked_policy",
					prompted: false,
					promptResponse: "na",
					upstreamForwarded: false,
					txFingerprint: hash("3"),
					actionFingerprint: hash("4"),
				},
				{
					...makeBase({
						ts: "2026-02-13T10:05:00.000Z",
						installId: installA,
						correlationId: retryCorrelation,
						actorWalletHash: walletA,
					}),
					event: "scan_result",
					requestId: crypto.randomUUID(),
					recommendation: "caution",
					severityBucket: "CAUTION",
					simulationStatus: "success",
					findingCodes: ["APPROVAL_LIMITED"],
					latencyMs: 80,
				},
				{
					...makeBase({
						ts: "2026-02-13T10:05:01.000Z",
						installId: installA,
						correlationId: retryCorrelation,
						actorWalletHash: walletA,
					}),
					event: "user_action_outcome",
					requestId: crypto.randomUUID(),
					recommendation: "caution",
					severityBucket: "CAUTION",
					decision: "forwarded",
					prompted: false,
					promptResponse: "na",
					upstreamForwarded: true,
					txFingerprint: hash("5"),
					actionFingerprint: hash("6"),
				},
				{
					...makeBase({
						ts: "2026-02-13T11:00:00.000Z",
						installId: installB,
						correlationId: safeCorrelation,
						actorWalletHash: walletB,
					}),
					event: "user_action_outcome",
					requestId: crypto.randomUUID(),
					recommendation: "ok",
					severityBucket: "SAFE",
					decision: "forwarded",
					prompted: false,
					promptResponse: "na",
					upstreamForwarded: true,
					txFingerprint: hash("7"),
					actionFingerprint: hash("8"),
				},
			]);

			const summary = await buildRollup({
				date: day2,
				eventsDir: tmpDir,
				windowDays: 7,
			});

			expect(summary.decisionSessions).toBe(3);
			expect(summary.outcomesTotal).toBe(3);
			expect(summary.proceedBlockBySeverity.BLOCK.blocked).toBe(1);
			expect(summary.proceedBlockBySeverity.CAUTION.forwarded).toBe(1);
			expect(summary.repeatUse.dauInstalls).toBe(2);
			expect(summary.repeatUse.returningInstallCount).toBe(1);
			expect(summary.editRetryInference.retryAfterBlockWithin30m).toBe(1);
			expect(summary.editRetryInference.editAndRetryInferred).toBe(1);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
