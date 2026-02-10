#!/usr/bin/env bun

interface Scenario {
	id: string;
	description: string;
	args: string[];
	expectedExitCode: number;
}

interface ScenarioStats {
	id: string;
	description: string;
	samplesMs: number[];
	minMs: number;
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
}

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
}

interface BenchmarkConfig {
	iterations: number;
	warmupRuns: number;
	timeoutMs: number;
}

const SAFE_TX_HASH = "0xcc29eb7274575a6f5ff90a15f0ecc267bb8f8253feb1f659c828ef09e5bc4152";

export const BENCHMARK_SCENARIOS: Scenario[] = [
	{
		id: "scan-known-safe-address",
		description: "scan known-safe address",
		args: ["scan", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "--format", "json", "--quiet"],
		expectedExitCode: 0,
	},
	{
		id: "scan-risky-unverified-address",
		description: "scan risky/unverified address",
		args: ["scan", "0x7768a894e6d0160530c0b386c0a963989239f107", "--format", "json", "--quiet"],
		expectedExitCode: 2,
	},
	{
		id: "scan-no-sim-fixture-calldata",
		description: "scan --no-sim with fixture calldata",
		args: [
			"scan",
			"--calldata",
			"@test/fixtures/txs/erc20-approve-usdc-permit2-max.json",
			"--no-sim",
			"--fail-on",
			"danger",
			"--format",
			"json",
			"--quiet",
		],
		expectedExitCode: 0,
	},
	{
		id: "safe-offline-fixture-success",
		description: "safe offline fixture ingest success",
		args: [
			"safe",
			"arbitrum",
			SAFE_TX_HASH,
			"--offline",
			"--safe-tx-json",
			"test/fixtures/safe/arb1/cc29eb72/tx.json",
			"--format",
			"json",
		],
		expectedExitCode: 0,
	},
	{
		id: "safe-offline-broken-fixture-fast-fail",
		description: "safe broken fixture fast-fail",
		args: [
			"safe",
			"arbitrum",
			SAFE_TX_HASH,
			"--offline",
			"--safe-tx-json",
			"test/fixtures/safe/arb1/broken-tx.json",
		],
		expectedExitCode: 1,
	},
];

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Invalid numeric value: ${raw}`);
	}
	return parsed;
}

function parseArgs(argv: string[]): BenchmarkConfig {
	const iterations = parsePositiveInt(getFlagValue(argv, "--iterations"), 7);
	const warmupRuns = parsePositiveInt(getFlagValue(argv, "--warmup"), 1);
	const timeoutMs = parsePositiveInt(getFlagValue(argv, "--timeout-ms"), 120_000);
	return {
		iterations,
		warmupRuns,
		timeoutMs,
	};
}

function getFlagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index === -1) return undefined;
	return args[index + 1];
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) {
		throw new Error("Cannot compute percentile on empty samples");
	}
	if (values.length === 1) return values[0];
	const sorted = [...values].sort((a, b) => a - b);
	const position = (sorted.length - 1) * p;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) {
		return sorted[lower];
	}
	const fraction = position - lower;
	return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

export function summarizeSamples(samplesMs: number[]): Omit<ScenarioStats, "id" | "description"> {
	if (samplesMs.length === 0) {
		throw new Error("Cannot summarize empty sample list");
	}
	const sorted = [...samplesMs].sort((a, b) => a - b);
	return {
		samplesMs,
		minMs: sorted[0],
		p50Ms: percentile(sorted, 0.5),
		p95Ms: percentile(sorted, 0.95),
		maxMs: sorted[sorted.length - 1],
	};
}

function formatMs(value: number): string {
	return value.toFixed(1);
}

function truncateForError(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= 500) return trimmed;
	return `${trimmed.slice(0, 500)}...`;
}

function assertExpectedExitCode(result: RunResult, scenario: Scenario, phase: string, run: number) {
	if (result.timedOut) {
		throw new Error(
			`${scenario.id} ${phase} run ${run} timed out after ${result.durationMs.toFixed(1)}ms`,
		);
	}
	if (result.exitCode !== scenario.expectedExitCode) {
		const stderr = truncateForError(result.stderr);
		const stdout = truncateForError(result.stdout);
		throw new Error(
			[
				`${scenario.id} ${phase} run ${run} exited ${result.exitCode} (expected ${scenario.expectedExitCode})`,
				stderr ? `stderr: ${stderr}` : "",
				stdout ? `stdout: ${stdout}` : "",
			]
				.filter((line) => line.length > 0)
				.join("\n"),
		);
	}
}

async function runCliOnce(args: string[], timeoutMs: number): Promise<RunResult> {
	const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
	const startedAt = performance.now();
	const proc = Bun.spawn(
		["timeout", "--signal=KILL", `${timeoutSeconds}s`, "bun", "run", "src/cli/index.ts", ...args],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, NO_COLOR: "1" },
		},
	);

	const stdoutPromise = new Response(proc.stdout).text();
	const stderrPromise = new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

	const timedOut = exitCode === 124 || exitCode === 137;
	return {
		exitCode,
		stdout,
		stderr,
		durationMs: performance.now() - startedAt,
		timedOut,
	};
}

async function runScenario(scenario: Scenario, config: BenchmarkConfig): Promise<ScenarioStats> {
	for (let i = 0; i < config.warmupRuns; i += 1) {
		const warmupRun = await runCliOnce(scenario.args, config.timeoutMs);
		assertExpectedExitCode(warmupRun, scenario, "warmup", i + 1);
	}

	const samplesMs: number[] = [];
	for (let i = 0; i < config.iterations; i += 1) {
		const measuredRun = await runCliOnce(scenario.args, config.timeoutMs);
		assertExpectedExitCode(measuredRun, scenario, "measured", i + 1);
		samplesMs.push(measuredRun.durationMs);
	}

	return {
		id: scenario.id,
		description: scenario.description,
		...summarizeSamples(samplesMs),
	};
}

function renderSummaryMarkdown(
	results: ScenarioStats[],
	config: BenchmarkConfig,
	elapsedMs: number,
): string {
	const lines: string[] = [];
	lines.push("# Assay CLI Latency Benchmark");
	lines.push("");
	lines.push(`- Iterations per scenario: ${config.iterations}`);
	lines.push(`- Warmup runs per scenario: ${config.warmupRuns}`);
	lines.push(`- Timeout per run: ${config.timeoutMs} ms`);
	lines.push(`- Total benchmark wall time: ${formatMs(elapsedMs)} ms`);
	lines.push("");
	lines.push("| Scenario | min (ms) | p50 (ms) | p95 (ms) | max (ms) |");
	lines.push("| --- | ---: | ---: | ---: | ---: |");
	for (const result of results) {
		lines.push(
			`| ${result.description} | ${formatMs(result.minMs)} | ${formatMs(result.p50Ms)} | ${formatMs(result.p95Ms)} | ${formatMs(result.maxMs)} |`,
		);
	}
	return lines.join("\n");
}

async function main() {
	const config = parseArgs(process.argv.slice(2));
	const startedAt = performance.now();
	const results: ScenarioStats[] = [];

	for (const scenario of BENCHMARK_SCENARIOS) {
		console.error(`Running: ${scenario.description}`);
		const result = await runScenario(scenario, config);
		results.push(result);
	}

	const elapsedMs = performance.now() - startedAt;
	console.log(renderSummaryMarkdown(results, config, elapsedMs));
}

if (import.meta.main) {
	await main();
}
