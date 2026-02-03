import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function stripAnsi(input: string): string {
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

const configPath = fileURLToPath(new URL("./fixtures/simulation-config.json", import.meta.url));
const anvilPath =
	process.env.RUGSCAN_ANVIL_PATH ?? path.join(os.homedir(), ".foundry", "bin", "anvil");
const anvilDir = path.dirname(anvilPath);

const calldata = JSON.stringify({
	to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
	from: "0x1111111111111111111111111111111111111111",
	data: "0xd0e30db0",
	value: "1000000000000000000",
	chain: "1",
});

function baseEnv() {
	return {
		RUGSCAN_CONFIG: configPath,
		NO_COLOR: "1",
		PATH: `${anvilDir}:${process.env.PATH ?? ""}`,
	};
}

describe("simulation e2e", () => {
	test(
		"scan --calldata runs anvil simulation and renders the result box",
		async () => {
			if (!existsSync(anvilPath)) {
				throw new Error(`Missing anvil binary at ${anvilPath}`);
			}

			const result = await runCli(
				["scan", "--calldata", calldata, "--quiet"],
				baseEnv(),
			);

			expect(result.exitCode).toBe(0);
			const output = stripAnsi(result.stdout).trim();
			expect(output).toContain("┌");
			expect(output).toContain("Protocol:");
			expect(output).toContain("Action:");
			expect(output).toContain("Contract:");
			expect(output).toContain("💰 BALANCE CHANGES");
			expect(output).toContain("- 1 ETH");
			expect(output).toContain("+ 1 WETH");
			expect(output).toContain("🔐 APPROVALS");
			expect(output).toContain("📊 RISK:");
			expect(output).not.toContain("Simulation pending");
			expect(output).not.toContain("Simulation failed");
		},
		180000,
	);

	test(
		"scan --calldata returns anvil simulation metadata",
		async () => {
			if (!existsSync(anvilPath)) {
				throw new Error(`Missing anvil binary at ${anvilPath}`);
			}

			const result = await runCli(
				["scan", "--calldata", calldata, "--format", "json", "--quiet"],
				baseEnv(),
			);

			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.stdout);
			const simulation = parsed?.scan?.simulation;
			expect(simulation).toBeDefined();
			expect(simulation?.success).toBe(true);
			const notes = Array.isArray(simulation?.notes) ? simulation.notes : [];
			const hasHeuristicNote = notes.some((note: unknown) =>
				typeof note === "string" && note.includes("Heuristic-only simulation"),
			);
			expect(hasHeuristicNote).toBe(false);
		},
		180000,
	);
});
