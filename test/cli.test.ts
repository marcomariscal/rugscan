import { test as bunTest, describe, expect } from "bun:test";

const test = process.env.ASSAY_LIVE_TESTS === "1" ? bunTest : bunTest.skip;

async function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}) {
	const env = { ...process.env, ...envOverrides };
	const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

describe("cli", () => {
	test("scan exit codes (with --fail-on caution): OK=0, CAUTION/WARNING=2, DANGER=2", async () => {
		const okResult = await runCli([
			"scan",
			"0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
			"--fail-on",
			"caution",
		]);
		expect(okResult.exitCode).toBe(0);

		const cautionResult = await runCli([
			"scan",
			"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
			"--fail-on",
			"caution",
		]);
		expect(cautionResult.exitCode).toBe(2);

		const dangerResult = await runCli([
			"scan",
			"0xdAC17F958D2ee523a2206206994597C13D831ec7",
			"--fail-on",
			"caution",
		]);
		expect(dangerResult.exitCode).toBe(2);
	}, 120000);

	test("--chain flag targets the requested network", async () => {
		const result = await runCli([
			"scan",
			"0x4200000000000000000000000000000000000006",
			"--chain",
			"base",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Chain: base");
	}, 120000);

	test("invalid addresses return exit code 1", async () => {
		const result = await runCli(["scan", "not-an-address"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("valid address or calldata input");
	});

	test("unknown option returns exit code 1", async () => {
		const result = await runCli(["scan", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "--bogus"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Unknown option");
	});
});
