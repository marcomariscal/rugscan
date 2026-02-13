#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type TelemetryEvent, telemetryEventSchema } from "../src/telemetry";

type OutcomeEvent = Extract<TelemetryEvent, { event: "user_action_outcome" }>;

type RollupArgs = {
	date: string;
	eventsDir: string;
	windowDays: number;
	outputPath?: string;
};

type BucketStats = {
	total: number;
	forwarded: number;
	blocked: number;
	errored: number;
	forwardRate: number;
	blockRate: number;
};

type RollupSummary = {
	date: string;
	eventsDir: string;
	parsedEvents: number;
	invalidLinesDropped: number;
	decisionSessions: number;
	outcomesTotal: number;
	proceedBlockBySeverity: Record<"SAFE" | "CAUTION" | "WARNING" | "BLOCK", BucketStats>;
	repeatUse: {
		dauInstalls: number;
		wauInstalls: number;
		returningInstallCount: number;
		returningInstallRate: number;
		dauWallets: number;
		returningWalletCount: number;
		returningWalletRate: number;
	};
	editRetryInference: {
		blockedOutcomes: number;
		retryAfterBlockWithin30m: number;
		editAndRetryInferred: number;
		retrySameFingerprint: number;
		retryFingerprintUnknown: number;
	};
	filesScanned: string[];
};

function defaultEventsDir(): string {
	return path.join(os.homedir(), ".config", "assay", "telemetry", "events");
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Invalid numeric value: ${value}`);
	}
	return parsed;
}

function parseArgs(argv: string[]): RollupArgs {
	const date = getFlagValue(argv, "--date") ?? new Date().toISOString().slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`Invalid --date value: ${date} (expected YYYY-MM-DD, UTC)`);
	}
	const eventsDir = getFlagValue(argv, "--events-dir") ?? defaultEventsDir();
	const windowDays = parsePositiveInt(getFlagValue(argv, "--window-days"), 7);
	const outputPath = getFlagValue(argv, "--out");
	return { date, eventsDir, windowDays, outputPath };
}

function getFlagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index === -1) return undefined;
	return args[index + 1];
}

function dateOffsets(endDate: string, days: number): string[] {
	const end = new Date(`${endDate}T00:00:00.000Z`);
	if (Number.isNaN(end.getTime())) {
		throw new Error(`Invalid date: ${endDate}`);
	}
	const result: string[] = [];
	for (let i = 0; i < days; i += 1) {
		const current = new Date(end);
		current.setUTCDate(end.getUTCDate() - i);
		result.push(current.toISOString().slice(0, 10));
	}
	return result;
}

async function readEvents(
	filePath: string,
): Promise<{ events: TelemetryEvent[]; invalid: number }> {
	if (!existsSync(filePath)) {
		return { events: [], invalid: 0 };
	}
	const raw = await readFile(filePath, "utf-8");
	if (raw.trim().length === 0) {
		return { events: [], invalid: 0 };
	}

	const events: TelemetryEvent[] = [];
	let invalid = 0;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsedJson = JSON.parse(trimmed);
			const parsed = telemetryEventSchema.safeParse(parsedJson);
			if (!parsed.success) {
				invalid += 1;
				continue;
			}
			events.push(parsed.data);
		} catch {
			invalid += 1;
		}
	}
	return { events, invalid };
}

function uniqueSet(values: Array<string | null | undefined>): Set<string> {
	const result = new Set<string>();
	for (const value of values) {
		if (!value) continue;
		result.add(value);
	}
	return result;
}

function toOutcomeEvent(event: TelemetryEvent): OutcomeEvent | null {
	if (event.event !== "user_action_outcome") return null;
	return event;
}

function buildBucketStats(outcomes: OutcomeEvent[]): RollupSummary["proceedBlockBySeverity"] {
	const buckets: RollupSummary["proceedBlockBySeverity"] = {
		SAFE: makeEmptyBucket(),
		CAUTION: makeEmptyBucket(),
		WARNING: makeEmptyBucket(),
		BLOCK: makeEmptyBucket(),
	};

	for (const outcome of outcomes) {
		const target = buckets[outcome.severityBucket];
		target.total += 1;
		if (outcome.decision === "forwarded") {
			target.forwarded += 1;
		} else if (outcome.decision === "error") {
			target.errored += 1;
		} else {
			target.blocked += 1;
		}
	}

	for (const bucket of Object.values(buckets)) {
		if (bucket.total > 0) {
			bucket.forwardRate = bucket.forwarded / bucket.total;
			bucket.blockRate = bucket.blocked / bucket.total;
		}
	}

	return buckets;
}

function makeEmptyBucket(): BucketStats {
	return {
		total: 0,
		forwarded: 0,
		blocked: 0,
		errored: 0,
		forwardRate: 0,
		blockRate: 0,
	};
}

function inferEditRetries(outcomes: OutcomeEvent[]): RollupSummary["editRetryInference"] {
	const sorted = [...outcomes].sort((a, b) => a.ts.localeCompare(b.ts));
	let blockedOutcomes = 0;
	let retryAfterBlockWithin30m = 0;
	let editAndRetryInferred = 0;
	let retrySameFingerprint = 0;
	let retryFingerprintUnknown = 0;

	for (let i = 0; i < sorted.length; i += 1) {
		const current = sorted[i];
		if (!current || current.decision === "forwarded" || current.decision === "error") continue;
		blockedOutcomes += 1;

		const startedAt = Date.parse(current.ts);
		if (Number.isNaN(startedAt)) continue;

		for (let j = i + 1; j < sorted.length; j += 1) {
			const next = sorted[j];
			if (!next || next.installId !== current.installId) continue;
			if (next.chain !== current.chain) continue;
			const nextAt = Date.parse(next.ts);
			if (Number.isNaN(nextAt)) continue;
			if (nextAt - startedAt > 30 * 60 * 1000) break;
			if (next.decision !== "forwarded") continue;

			retryAfterBlockWithin30m += 1;
			if (!current.actionFingerprint || !next.actionFingerprint) {
				retryFingerprintUnknown += 1;
				break;
			}
			if (current.actionFingerprint === next.actionFingerprint) {
				retrySameFingerprint += 1;
			} else {
				editAndRetryInferred += 1;
			}
			break;
		}
	}

	return {
		blockedOutcomes,
		retryAfterBlockWithin30m,
		editAndRetryInferred,
		retrySameFingerprint,
		retryFingerprintUnknown,
	};
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function renderReport(summary: RollupSummary): string {
	const lines: string[] = [];
	lines.push(`# Assay prove/kill rollup — ${summary.date} (UTC)`);
	lines.push("");
	lines.push(`- Events dir: ${summary.eventsDir}`);
	lines.push(`- Files scanned: ${summary.filesScanned.length}`);
	lines.push(`- Parsed events: ${summary.parsedEvents}`);
	lines.push(`- Dropped invalid lines: ${summary.invalidLinesDropped}`);
	lines.push("");
	lines.push("## Decision sessions");
	lines.push(`- Decision sessions (unique correlation IDs): ${summary.decisionSessions}`);
	lines.push(`- user_action_outcome events: ${summary.outcomesTotal}`);
	lines.push("");
	lines.push("## Proceed/block by severity");
	const severities: Array<"SAFE" | "CAUTION" | "WARNING" | "BLOCK"> = [
		"SAFE",
		"CAUTION",
		"WARNING",
		"BLOCK",
	];
	for (const severity of severities) {
		const stats = summary.proceedBlockBySeverity[severity];
		lines.push(
			`- ${severity}: total=${stats.total}, proceed=${stats.forwarded} (${percent(stats.forwardRate)}), block=${stats.blocked} (${percent(stats.blockRate)}), error=${stats.errored}`,
		);
	}
	lines.push("");
	lines.push("## Repeat-use snapshot");
	lines.push(`- DAU installs: ${summary.repeatUse.dauInstalls}`);
	lines.push(
		`- WAU installs (${summary.date} trailing 7d default): ${summary.repeatUse.wauInstalls}`,
	);
	lines.push(
		`- Returning installs today: ${summary.repeatUse.returningInstallCount} (${percent(summary.repeatUse.returningInstallRate)})`,
	);
	lines.push(`- DAU wallets (hashed): ${summary.repeatUse.dauWallets}`);
	lines.push(
		`- Returning wallets today: ${summary.repeatUse.returningWalletCount} (${percent(summary.repeatUse.returningWalletRate)})`,
	);
	lines.push("");
	lines.push("## Edit-retry inference (heuristic)");
	lines.push(`- Blocked outcomes: ${summary.editRetryInference.blockedOutcomes}`);
	lines.push(
		`- Retry-after-block within 30m: ${summary.editRetryInference.retryAfterBlockWithin30m}`,
	);
	lines.push(`- Edit-and-retry inferred: ${summary.editRetryInference.editAndRetryInferred}`);
	lines.push(`- Retry same fingerprint: ${summary.editRetryInference.retrySameFingerprint}`);
	lines.push(`- Retry fingerprint unknown: ${summary.editRetryInference.retryFingerprintUnknown}`);
	return lines.join("\n");
}

async function buildRollup(args: RollupArgs): Promise<RollupSummary> {
	const targetDates = dateOffsets(args.date, args.windowDays);
	const filesScanned = targetDates
		.map((date) => path.join(args.eventsDir, `${date}.jsonl`))
		.filter((filePath) => existsSync(filePath));

	const eventsByDate = new Map<string, TelemetryEvent[]>();
	let invalidLinesDropped = 0;

	for (const date of targetDates) {
		const filePath = path.join(args.eventsDir, `${date}.jsonl`);
		const { events, invalid } = await readEvents(filePath);
		eventsByDate.set(date, events);
		invalidLinesDropped += invalid;
	}

	const dayEvents = eventsByDate.get(args.date) ?? [];
	const trailingWindowEvents = targetDates.flatMap((date) => eventsByDate.get(date) ?? []);
	const priorDays = targetDates.filter((date) => date !== args.date);
	const priorEvents = priorDays.flatMap((date) => eventsByDate.get(date) ?? []);

	const dayOutcomes = dayEvents
		.map(toOutcomeEvent)
		.filter((event): event is OutcomeEvent => event !== null);
	const decisionSessions = uniqueSet(dayOutcomes.map((event) => event.correlationId)).size;

	const dayActiveEvents = dayEvents.filter(
		(event) =>
			event.event === "scan_started" ||
			event.event === "scan_result" ||
			event.event === "user_action_outcome",
	);
	const priorActiveEvents = priorEvents.filter(
		(event) =>
			event.event === "scan_started" ||
			event.event === "scan_result" ||
			event.event === "user_action_outcome",
	);

	const dauInstalls = uniqueSet(dayActiveEvents.map((event) => event.installId));
	const wauInstalls = uniqueSet(trailingWindowEvents.map((event) => event.installId));
	const priorInstalls = uniqueSet(priorActiveEvents.map((event) => event.installId));
	let returningInstallCount = 0;
	for (const install of dauInstalls) {
		if (priorInstalls.has(install)) {
			returningInstallCount += 1;
		}
	}

	const dauWallets = uniqueSet(dayActiveEvents.map((event) => event.actorWalletHash));
	const priorWallets = uniqueSet(priorActiveEvents.map((event) => event.actorWalletHash));
	let returningWalletCount = 0;
	for (const wallet of dauWallets) {
		if (priorWallets.has(wallet)) {
			returningWalletCount += 1;
		}
	}

	return {
		date: args.date,
		eventsDir: args.eventsDir,
		parsedEvents: dayEvents.length,
		invalidLinesDropped,
		decisionSessions,
		outcomesTotal: dayOutcomes.length,
		proceedBlockBySeverity: buildBucketStats(dayOutcomes),
		repeatUse: {
			dauInstalls: dauInstalls.size,
			wauInstalls: wauInstalls.size,
			returningInstallCount,
			returningInstallRate: dauInstalls.size > 0 ? returningInstallCount / dauInstalls.size : 0,
			dauWallets: dauWallets.size,
			returningWalletCount,
			returningWalletRate: dauWallets.size > 0 ? returningWalletCount / dauWallets.size : 0,
		},
		editRetryInference: inferEditRetries(dayOutcomes),
		filesScanned,
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const summary = await buildRollup(args);
	const report = renderReport(summary);
	console.log(report);

	if (args.outputPath) {
		const outputPath = path.resolve(args.outputPath);
		await mkdir(path.dirname(outputPath), { recursive: true });
		const payload = `${JSON.stringify(summary, null, 2)}\n`;
		await writeFile(outputPath, payload, "utf-8");
		console.error(`Saved JSON summary: ${outputPath}`);
	}
}

if (import.meta.main) {
	await main();
}

export { buildRollup, renderReport, type RollupSummary, type RollupArgs };
