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
	test("intricate Safe multisend fixture renders deterministic text summary", async () => {
		const result = await runCli([
			"safe",
			"arbitrum",
			SAFE_TX_HASH,
			"--offline",
			"--safe-tx-json",
			SAFE_FIXTURE_PATH,
			"--format",
			"text",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr.trim()).toBe("");

		const stdout = stripAnsi(result.stdout);
		expect(stdout).toContain("Safe ingest on arbitrum");
		expect(stdout).toContain(`SafeTxHash: ${SAFE_TX_HASH}`);
		expect(stdout).toContain("Kind: multisend");
		expect(stdout).toContain("Safe: 0xf3b46870658211414684e061bc1514213e80c49c");
		expect(stdout).toContain("Calls: 2");
	});

	test("broken Safe fixture surfaces parse failure in CLI output", async () => {
		const result = await runCli([
			"safe",
			"arbitrum",
			SAFE_TX_HASH,
			"--offline",
			"--safe-tx-json",
			BROKEN_SAFE_FIXTURE_PATH,
			"--format",
			"text",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Safe ingest failed:");
		expect(result.stderr).toContain("Invalid Safe Transaction Service response");
	});
});
