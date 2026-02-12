import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

async function runDoctor(envOverrides: Record<string, string | undefined>) {
	const env = { ...process.env, ...envOverrides };
	const proc = Bun.spawn([process.execPath, "run", "src/cli/index.ts", "doctor"], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

function writeConfig(dir: string, value: unknown): string {
	const configPath = path.join(dir, "assay.config.json");
	writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	return configPath;
}

describe("assay doctor", () => {
	test("passes when configured simulation.anvilPath exists", async () => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "assay-doctor-configured-"));
		const anvilPath = path.join(tmpDir, "anvil");
		writeFileSync(anvilPath, "#!/usr/bin/env bash\necho anvil\n", "utf-8");
		const configPath = writeConfig(tmpDir, {
			simulation: {
				anvilPath,
			},
		});

		const result = await runDoctor({
			ASSAY_CONFIG: configPath,
			PATH: tmpDir,
			HOME: tmpDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("Doctor: simulation prerequisites OK");
		expect(result.stdout).toContain(anvilPath);
	});

	test("passes when anvil is available on PATH", async () => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "assay-doctor-path-"));
		const binDir = path.join(tmpDir, "bin");
		const anvilPath = path.join(binDir, "anvil");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(anvilPath, "#!/usr/bin/env bash\necho anvil\n", "utf-8");
		const configPath = writeConfig(tmpDir, {});

		const result = await runDoctor({
			ASSAY_CONFIG: configPath,
			PATH: binDir,
			HOME: tmpDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("Doctor: simulation prerequisites OK");
		expect(result.stdout).toContain("(PATH)");
	});

	test("fails with install guidance when anvil is missing", async () => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "assay-doctor-missing-"));
		const emptyPathDir = path.join(tmpDir, "empty-path");
		mkdirSync(emptyPathDir, { recursive: true });
		const configPath = writeConfig(tmpDir, {});

		const result = await runDoctor({
			ASSAY_CONFIG: configPath,
			PATH: emptyPathDir,
			HOME: tmpDir,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("Doctor: missing simulation prerequisite");
		expect(result.stdout).toContain("https://getfoundry.sh");
		expect(result.stdout).toContain("foundryup");
		expect(result.stdout).toContain("Simulation will not run");
	});
});
