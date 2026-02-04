import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TxCalldata {
	to: string;
	from: string;
	value: string;
	data: string;
}

export interface TxFixture {
	name: string;
	chainId: number;
	forkBlock: number;
	tx: TxCalldata;
	notes?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function isTxFixture(value: unknown): value is TxFixture {
	if (!isRecord(value)) return false;
	if (!isNonEmptyString(value.name)) return false;
	if (!isFiniteNumber(value.chainId)) return false;
	if (!isFiniteNumber(value.forkBlock)) return false;
	if (!isRecord(value.tx)) return false;
	if (!isNonEmptyString(value.tx.to)) return false;
	if (!isNonEmptyString(value.tx.from)) return false;
	if (!isNonEmptyString(value.tx.value)) return false;
	if (!isNonEmptyString(value.tx.data)) return false;
	return true;
}

function parseSimulationSuccess(stdout: string): boolean | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const scan = parsed.scan;
	if (!isRecord(scan)) return null;
	const simulation = scan.simulation;
	if (!isRecord(simulation)) return null;
	const success = simulation.success;
	if (typeof success !== "boolean") return null;
	return success;
}

async function runOnce(options: {
	fixture: TxFixture;
	format: "json";
	rpcUrl: string;
	anvilPath: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const tmpDir = await mkdtemp(path.join(os.tmpdir(), "rugscan-e2e-"));
	const configPath = path.join(tmpDir, "config.json");
	await writeFile(
		configPath,
		JSON.stringify(
			{
				simulation: {
					enabled: true,
					forkBlock: options.fixture.forkBlock,
					rpcUrl: options.rpcUrl,
					anvilPath: options.anvilPath,
				},
			},
			null,
			2,
		),
	);

	const calldata = JSON.stringify({
		to: options.fixture.tx.to,
		from: options.fixture.tx.from,
		value: options.fixture.tx.value,
		data: options.fixture.tx.data,
		chain: String(options.fixture.chainId),
	});

	const args = ["scan", "--calldata", calldata, "--format", options.format, "--quiet"];
	const env = {
		...process.env,
		RUGSCAN_CONFIG: configPath,
		NO_COLOR: "1",
	};

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

export async function runRugscanScanWithTempForkConfig(options: {
	fixture: TxFixture;
	format?: "json";
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const anvilPath =
		process.env.RUGSCAN_ANVIL_PATH ?? path.join(os.homedir(), ".foundry", "bin", "anvil");
	if (!existsSync(anvilPath)) {
		throw new Error(`Anvil not found at ${anvilPath}`);
	}

	const rpcUrls = process.env.RUGSCAN_TEST_RPC_URL
		? [process.env.RUGSCAN_TEST_RPC_URL]
		: ["https://eth.drpc.org", "https://ethereum.publicnode.com", "https://eth.llamarpc.com"];

	let lastResult: { exitCode: number; stdout: string; stderr: string } | null = null;

	for (const rpcUrl of rpcUrls) {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const result = await runOnce({
				fixture: options.fixture,
				format: options.format ?? "json",
				rpcUrl,
				anvilPath,
			});
			lastResult = result;

			const success = parseSimulationSuccess(result.stdout);
			if (success === true) return result;
			if (success === null) return result;
		}
	}

	if (!lastResult) {
		return { exitCode: 1, stdout: "", stderr: "No RPC URLs available" };
	}
	return lastResult;
}
