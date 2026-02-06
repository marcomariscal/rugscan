import { test as bunTest, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const test = process.env.RUGSCAN_FORK_E2E === "1" ? bunTest : bunTest.skip;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function ensureSimulationSuccess(parsed: unknown): Record<string, unknown> {
	expect(isRecord(parsed)).toBe(true);
	if (!isRecord(parsed)) throw new Error("Invalid response");

	const scan = parsed.scan;
	expect(isRecord(scan)).toBe(true);
	if (!isRecord(scan)) throw new Error("Missing scan");

	const simulation = scan.simulation;
	expect(isRecord(simulation)).toBe(true);
	if (!isRecord(simulation)) throw new Error("Missing simulation");

	expect(simulation.success).toBe(true);
	return { scan, simulation };
}

function assetChangesOf(simulation: Record<string, unknown>): Record<string, unknown>[] {
	const assetChanges = simulation.assetChanges;
	if (!Array.isArray(assetChanges)) return [];
	return assetChanges.filter((change): change is Record<string, unknown> => isRecord(change));
}

function findErc20Changes(changes: Record<string, unknown>[], direction: "in" | "out") {
	return changes.filter((change) => change.assetType === "erc20" && change.direction === direction);
}

type FixtureExpectations = {
	nativeDiff: "negative" | "positive";
	erc20In?: boolean;
	erc20Out?: boolean;
};

type Fixture = {
	name: string;
	txPath: string;
	configPath: string;
	expectations: FixtureExpectations;
};

const bunDir = path.dirname(process.execPath);
const foundryDefaultAnvilPath = path.join(os.homedir(), ".foundry", "bin", "anvil");

const fixtures: Fixture[] = [
	{
		name: "Aave V3 gateway deposit 1 ETH",
		txPath: fileURLToPath(
			new URL("./fixtures/lend-borrow/aave-v3-gateway-deposit-1eth.tx.json", import.meta.url),
		),
		configPath: fileURLToPath(
			new URL("./fixtures/lend-borrow/aave-v3-gateway-deposit-1eth.config.json", import.meta.url),
		),
		expectations: { nativeDiff: "negative", erc20In: true },
	},
	{
		name: "Aave V3 gateway deposit 0.1 ETH",
		txPath: fileURLToPath(
			new URL("./fixtures/lend-borrow/aave-v3-gateway-deposit-0.1eth.tx.json", import.meta.url),
		),
		configPath: fileURLToPath(
			new URL("./fixtures/lend-borrow/aave-v3-gateway-deposit-0.1eth.config.json", import.meta.url),
		),
		expectations: { nativeDiff: "negative", erc20In: true },
	},
	{
		name: "Aave V3 gateway withdraw ETH",
		txPath: fileURLToPath(
			new URL("./fixtures/lend-borrow/aave-v3-gateway-withdraw.tx.json", import.meta.url),
		),
		configPath: fileURLToPath(
			new URL("./fixtures/lend-borrow/aave-v3-gateway-withdraw.config.json", import.meta.url),
		),
		expectations: { nativeDiff: "positive", erc20Out: true },
	},
	{
		name: "Aave V3 gateway borrow ETH",
		txPath: fileURLToPath(
			new URL("./fixtures/lend-borrow/aave-v3-gateway-borrow.tx.json", import.meta.url),
		),
		configPath: fileURLToPath(
			new URL("./fixtures/lend-borrow/aave-v3-gateway-borrow.config.json", import.meta.url),
		),
		expectations: { nativeDiff: "positive", erc20In: true },
	},
	{
		name: "Aave V3 gateway repay ETH",
		txPath: fileURLToPath(
			new URL("./fixtures/lend-borrow/aave-v3-gateway-repay.tx.json", import.meta.url),
		),
		configPath: fileURLToPath(
			new URL("./fixtures/lend-borrow/aave-v3-gateway-repay.config.json", import.meta.url),
		),
		expectations: { nativeDiff: "negative", erc20Out: true },
	},
];

describe("lend/borrow simulation fixtures e2e", () => {
	for (const fixture of fixtures) {
		test(`${fixture.name} simulates successfully and has non-empty intent/protocol labels`, async () => {
			if (!existsSync(foundryDefaultAnvilPath)) {
				return;
			}

			const rawFixture = await Bun.file(fixture.txPath).text();
			const parsedFixture = JSON.parse(rawFixture);
			expect(isRecord(parsedFixture)).toBe(true);
			if (!isRecord(parsedFixture)) throw new Error("Invalid fixture JSON");

			const calldata = JSON.stringify({
				to: parsedFixture.to,
				from: parsedFixture.from,
				value: parsedFixture.value,
				data: parsedFixture.data,
				chain: String(parsedFixture.chain),
			});

			const result = await runCli(
				["scan", "--calldata", calldata, "--format", "json", "--fail-on", "danger", "--quiet"],
				{
					RUGSCAN_CONFIG: fixture.configPath,
					NO_COLOR: "1",
					PATH: bunDir,
				},
			);

			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.stdout);
			const { scan, simulation } = ensureSimulationSuccess(parsed);

			// Protocol labeling should be non-empty.
			const contract = scan.contract;
			expect(isRecord(contract)).toBe(true);
			if (isRecord(contract)) {
				expect(isStringArray(contract.tags)).toBe(true);
				if (isStringArray(contract.tags)) {
					expect(contract.tags.length > 0).toBe(true);
					expect(nonEmptyString(contract.tags[0])).toBe(true);
				}
			}

			// Action labeling should be non-empty.
			expect(nonEmptyString(scan.intent)).toBe(true);

			const nativeDiffRaw = simulation.nativeDiff;
			expect(typeof nativeDiffRaw).toBe("string");
			if (typeof nativeDiffRaw === "string") {
				const diff = BigInt(nativeDiffRaw);
				if (fixture.expectations.nativeDiff === "negative") {
					expect(diff < 0n).toBe(true);
				} else {
					expect(diff > 0n).toBe(true);
				}
			}

			const changes = assetChangesOf(simulation);
			const erc20In = findErc20Changes(changes, "in");
			const erc20Out = findErc20Changes(changes, "out");

			if (fixture.expectations.erc20In) {
				expect(erc20In.length > 0).toBe(true);
			}
			if (fixture.expectations.erc20Out) {
				expect(erc20Out.length > 0).toBe(true);
			}
		}, 240000);
	}
});
