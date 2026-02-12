/**
 * Safe CLI flow matrix e2e tests.
 *
 * Tests the `assay safe` CLI command path with real Safe transaction fixtures.
 * Complements the scan replay flow matrix by exercising the dedicated Safe
 * ingest → per-call analysis pipeline.
 *
 * Gated on ASSAY_FORK_E2E=1 for simulation-enabled entries.
 */
import { test as bunTest, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

const testFork = process.env.ASSAY_FORK_E2E === "1" ? bunTest : bunTest.skip;

const foundryDefaultAnvilPath = path.join(process.env.HOME ?? "", ".foundry", "bin", "anvil");

const SAFE_ARB1_FIXTURE = "fixtures/safe/arb1/cc29eb72/tx.json";
const SAFE_ARB1_TX_HASH = "0xcc29eb7274575a6f5ff90a15f0ecc267bb8f8253feb1f659c828ef09e5bc4152";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function stripAnsi(input: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

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

describe("safe CLI flow matrix e2e", () => {
	bunTest(
		"Safe multisend offline JSON output has correct plan structure",
		async () => {
			const fixturePath = path.join(import.meta.dir, SAFE_ARB1_FIXTURE);
			const result = await runCli(
				[
					"safe",
					"arbitrum",
					SAFE_ARB1_TX_HASH,
					"--offline",
					"--safe-tx-json",
					fixturePath,
					"--format",
					"json",
				],
				{ NO_COLOR: "1" },
			);

			expect(result.exitCode).toBe(0);
			const parsed: unknown = JSON.parse(result.stdout);
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) throw new Error("Invalid JSON");

			expect(parsed.chain).toBe("arbitrum");
			expect(parsed.safeTxHash).toBe(SAFE_ARB1_TX_HASH);
			expect(isRecord(parsed.plan)).toBe(true);
			if (!isRecord(parsed.plan)) throw new Error("Missing plan");

			expect(parsed.plan.kind).toBe("multisend");
			expect(Array.isArray(parsed.plan.callsToAnalyze)).toBe(true);
			const calls = parsed.plan.callsToAnalyze;
			if (!Array.isArray(calls)) throw new Error("Missing calls");

			expect(calls.length).toBe(2);

			// Call 0: ERC20 approve on USDC (Arbitrum)
			const call0 = calls[0];
			expect(isRecord(call0)).toBe(true);
			if (!isRecord(call0)) throw new Error("Invalid call0");
			expect(isString(call0.to)).toBe(true);
			if (isString(call0.to)) {
				expect(call0.to).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
			}
			expect(call0.operation).toBe(0);
			expect(isString(call0.data)).toBe(true);
			if (isString(call0.data)) {
				expect(call0.data.startsWith("0x095ea7b3")).toBe(true);
			}

			// Call 1: Unknown contract call
			const call1 = calls[1];
			expect(isRecord(call1)).toBe(true);
			if (!isRecord(call1)) throw new Error("Invalid call1");
			expect(isString(call1.to)).toBe(true);
			if (isString(call1.to)) {
				expect(call1.to).toBe("0x2d2d600cae6d0fcb3f0ecb993736ea4703a2fdd0");
			}
			expect(call1.operation).toBe(0);
		},
		60000,
	);

	bunTest(
		"Safe multisend offline text output renders decision summary",
		async () => {
			const fixturePath = path.join(import.meta.dir, SAFE_ARB1_FIXTURE);
			const result = await runCli(
				["safe", "arbitrum", SAFE_ARB1_TX_HASH, "--offline", "--safe-tx-json", fixturePath],
				{ NO_COLOR: "1" },
			);

			expect(result.exitCode).toBe(0);
			const stdout = stripAnsi(result.stdout);
			expect(stdout).toContain("Safe scan on arbitrum");
			expect(stdout).toContain("Multisend");
			expect(stdout).toContain("2 calls");
			expect(stdout).toContain("Call 1");
			expect(stdout).toContain("Call 2");
		},
		60000,
	);

	testFork(
		"Safe multisend online analysis decodes per-call calldata (arb1)",
		async () => {
			if (!existsSync(foundryDefaultAnvilPath)) {
				return;
			}

			const fixturePath = path.join(import.meta.dir, SAFE_ARB1_FIXTURE);
			const result = await runCli(
				["safe", "arbitrum", SAFE_ARB1_TX_HASH, "--safe-tx-json", fixturePath, "--format", "json"],
				{ NO_COLOR: "1" },
			);

			// May exit 0 (ok) or 2 (danger findings from unverified sub-call)
			expect(result.exitCode === 0 || result.exitCode === 2).toBe(true);

			const parsed: unknown = JSON.parse(result.stdout);
			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) throw new Error("Invalid JSON");

			expect(parsed.chain).toBe("arbitrum");
			expect(isRecord(parsed.plan)).toBe(true);
			if (!isRecord(parsed.plan)) throw new Error("Missing plan");

			expect(parsed.plan.kind).toBe("multisend");
			const calls = parsed.plan.callsToAnalyze;
			expect(Array.isArray(calls)).toBe(true);
			if (!Array.isArray(calls)) throw new Error("Missing calls");
			expect(calls.length).toBe(2);

			// First call targets USDC contract — should have approve decoded
			const call0 = calls[0];
			expect(isRecord(call0)).toBe(true);
			if (isRecord(call0) && isString(call0.data)) {
				expect(call0.data.startsWith("0x095ea7b3")).toBe(true);
			}
		},
		240000,
	);
});
