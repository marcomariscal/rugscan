import { describe, expect, test } from "bun:test";

const SAFE_TX_HASH = "0xcc29eb7274575a6f5ff90a15f0ecc267bb8f8253feb1f659c828ef09e5bc4152";
const SAFE_FIXTURE_PATH = "test/fixtures/safe/arb1/cc29eb72/tx.json";
const BROKEN_SAFE_FIXTURE_PATH = "test/fixtures/safe/arb1/broken-tx.json";

function stripAnsi(input: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

async function runCli(args: string[]) {
	const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

describe("safe CLI output matrix", () => {
	test("intricate Safe multisend fixture renders user-facing summary (offline)", async () => {
		const result = await runCli([
			"safe",
			"arbitrum",
			SAFE_TX_HASH,
			"--offline",
			"--safe-tx-json",
			SAFE_FIXTURE_PATH,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr.trim()).toBe("");

		const stdout = stripAnsi(result.stdout);
		// Decision-summary framing (not raw plumbing)
		expect(stdout).toContain("Safe scan on arbitrum");
		expect(stdout).toContain("Multisend");
		expect(stdout).toContain("2 calls");
		// Per-call targets shown as short addresses (not raw hex dumps)
		expect(stdout).toContain("Call 1");
		expect(stdout).toContain("Call 2");
		// Offline: explicit messaging about analysis availability
		expect(stdout).toContain("analysis requires network");
		// Raw plumbing NOT shown in default mode
		expect(stdout).not.toContain("Kind:");
		expect(stdout).not.toContain("Calls:");
	});

	test("Safe multisend offline with --verbose shows safeTxHash", async () => {
		const result = await runCli([
			"safe",
			"arbitrum",
			SAFE_TX_HASH,
			"--offline",
			"--safe-tx-json",
			SAFE_FIXTURE_PATH,
			"--verbose",
		]);

		expect(result.exitCode).toBe(0);
		const stdout = stripAnsi(result.stdout);
		expect(stdout).toContain(SAFE_TX_HASH);
	});

	test("Safe multisend --format json outputs raw structured data", async () => {
		const result = await runCli([
			"safe",
			"arbitrum",
			SAFE_TX_HASH,
			"--offline",
			"--safe-tx-json",
			SAFE_FIXTURE_PATH,
			"--format",
			"json",
		]);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.chain).toBe("arbitrum");
		expect(parsed.safeTxHash).toBe(SAFE_TX_HASH);
		expect(parsed.plan.kind).toBe("multisend");
		expect(parsed.plan.callsToAnalyze.length).toBe(2);
	});

	test("broken Safe fixture surfaces parse failure in CLI output", async () => {
		const result = await runCli([
			"safe",
			"arbitrum",
			SAFE_TX_HASH,
			"--offline",
			"--safe-tx-json",
			BROKEN_SAFE_FIXTURE_PATH,
		]);

		expect(result.exitCode).toBe(1);
		// Heading is written to stdout before the error
		expect(result.stderr).toContain("Safe scan failed:");
		expect(result.stderr).toContain("Invalid Safe Transaction Service response");
	});
});
