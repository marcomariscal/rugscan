import { describe, expect, test } from "bun:test";

const SAFE_TX_HASH = "0xcc29eb7274575a6f5ff90a15f0ecc267bb8f8253feb1f659c828ef09e5bc4152";
const FIXTURE_PATH = "test/fixtures/safe/arb1/cc29eb72/tx.json";

async function runCli(args: string[]) {
	const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

describe("cli safe ingest (offline fixture)", () => {
	test("reads Safe Tx Service JSON from --tx-json and emits plan JSON", async () => {
		const result = await runCli([
			"safe",
			SAFE_TX_HASH,
			"--chain",
			"arbitrum",
			"--tx-json",
			`@${FIXTURE_PATH}`,
			"--format",
			"json",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr.trim()).toBe("");

		const payload = JSON.parse(result.stdout);
		expect(payload.chain).toBe("arbitrum");
		expect(payload.safeTxHash).toBe(SAFE_TX_HASH);
		expect(payload.plan.kind).toBe("multisend");
		expect(payload.plan.callsToAnalyze).toHaveLength(2);
	});
});
