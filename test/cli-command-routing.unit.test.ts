import { describe, expect, test } from "bun:test";

async function runCli(args: string[]) {
	const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

describe("cli command routing", () => {
	test("analyze command is removed and points users to scan", async () => {
		const result = await runCli(["analyze", "0x0000000000000000000000000000000000000001"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("assay analyze");
		expect(result.stderr).toContain("assay scan <address>");
	});
});
