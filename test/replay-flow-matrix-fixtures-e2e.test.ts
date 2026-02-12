import { test as bunTest, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

const test = process.env.ASSAY_FORK_E2E === "1" ? bunTest : bunTest.skip;

type NativeDiffExpectation = "positive" | "negative" | "zero";

type ReplayMatrixEntry = {
	flow: string;
	fixturePath: string;
	nativeDiff: NativeDiffExpectation;
	intentIncludes?: string;
	requireDecodedCalldata?: boolean;
	requireCalldataEmpty?: boolean;
};

type ParsedFixture = {
	chain: number;
	forkBlock: number;
	to: string;
	from: string;
	value: string;
	data: string;
};

const foundryDefaultAnvilPath = path.join(process.env.HOME ?? "", ".foundry", "bin", "anvil");

const REPLAY_MATRIX: ReplayMatrixEntry[] = [
	{
		flow: "Uniswap real swap",
		fixturePath: "fixtures/txs/uniswap-v4-universalrouter-eth-swap-873d55dd.json",
		nativeDiff: "negative",
		intentIncludes: "Uniswap Universal Router",
		requireDecodedCalldata: true,
	},
	{
		flow: "Aave real lend/supply",
		fixturePath: "fixtures/lend-borrow/aave-v3-gateway-deposit-1eth.tx.json",
		nativeDiff: "negative",
		intentIncludes: "Supply ETH to Aave",
		requireDecodedCalldata: true,
	},
	{
		flow: "Aave real borrow",
		fixturePath: "fixtures/lend-borrow/aave-v3-gateway-borrow.tx.json",
		nativeDiff: "positive",
		intentIncludes: "Borrow ETH from Aave",
		requireDecodedCalldata: true,
	},
	{
		flow: "ERC20 approve",
		fixturePath: "fixtures/txs/erc20-approve-usdc-limited.json",
		nativeDiff: "zero",
		intentIncludes: "Approve",
		requireDecodedCalldata: true,
	},
	{
		flow: "ERC20 transfer",
		fixturePath: "fixtures/txs/erc20-transfer-usdc-real.json",
		nativeDiff: "zero",
		intentIncludes: "Transfer",
		requireDecodedCalldata: true,
	},
	{
		flow: "ETH transfer",
		fixturePath: "fixtures/txs/eth-transfer-mainnet-real.json",
		nativeDiff: "negative",
		requireCalldataEmpty: true,
	},
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseFixture(value: unknown): ParsedFixture {
	if (!isRecord(value)) {
		throw new Error("Invalid fixture root");
	}

	if (
		isNumber(value.chain) &&
		isNumber(value.forkBlock) &&
		isString(value.to) &&
		isString(value.from) &&
		isString(value.value) &&
		isString(value.data)
	) {
		return {
			chain: value.chain,
			forkBlock: value.forkBlock,
			to: value.to,
			from: value.from,
			value: value.value,
			data: value.data,
		};
	}

	if (isNumber(value.chainId) && isNumber(value.forkBlock) && isRecord(value.tx)) {
		const tx = value.tx;
		if (isString(tx.to) && isString(tx.from) && isString(tx.value) && isString(tx.data)) {
			return {
				chain: value.chainId,
				forkBlock: value.forkBlock,
				to: tx.to,
				from: tx.from,
				value: tx.value,
				data: tx.data,
			};
		}
	}

	throw new Error("Unsupported fixture shape");
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

function parseSimulationSuccess(simulation: unknown): boolean {
	if (!isRecord(simulation)) return false;
	if (typeof simulation.success === "boolean") return simulation.success;
	return simulation.status === "success";
}

function readNativeDiff(simulation: unknown): bigint {
	if (!isRecord(simulation)) {
		throw new Error("Missing simulation object");
	}
	if (!isString(simulation.nativeDiff)) {
		throw new Error("simulation.nativeDiff missing or invalid");
	}
	return BigInt(simulation.nativeDiff);
}

function hasFindingCode(findings: unknown, code: string): boolean {
	if (!Array.isArray(findings)) return false;
	for (const finding of findings) {
		if (!isRecord(finding)) continue;
		if (finding.code === code) return true;
	}
	return false;
}

describe("real replay flow matrix e2e", () => {
	for (const entry of REPLAY_MATRIX) {
		test(`${entry.flow} (${entry.fixturePath})`, async () => {
			if (!existsSync(foundryDefaultAnvilPath)) {
				return;
			}

			const absoluteFixturePath = path.join(import.meta.dir, entry.fixturePath);
			const rawFixture = await Bun.file(absoluteFixturePath).text();
			const parsedFixture = parseFixture(JSON.parse(rawFixture));

			const calldata = JSON.stringify({
				to: parsedFixture.to,
				from: parsedFixture.from,
				value: parsedFixture.value,
				data: parsedFixture.data,
				chain: String(parsedFixture.chain),
			});

			const configPath = path.join(
				process.env.TMPDIR ?? "/tmp",
				`assay-replay-matrix-${entry.flow.replace(/[^a-zA-Z0-9]+/g, "-")}-${Date.now()}.json`,
			);
			await Bun.write(
				configPath,
				JSON.stringify({ simulation: { enabled: true, forkBlock: parsedFixture.forkBlock } }),
			);

			const result = await runCli(
				["scan", "--calldata", calldata, "--format", "json", "--fail-on", "danger", "--quiet"],
				{
					ASSAY_CONFIG: configPath,
					NO_COLOR: "1",
				},
			);

			expect(result.exitCode === 0 || result.exitCode === 2).toBe(true);

			let parsed: unknown;
			try {
				parsed = JSON.parse(result.stdout);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to parse JSON output for ${entry.flow}: ${message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
				);
			}

			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) throw new Error("Invalid CLI output");
			expect(isRecord(parsed.scan)).toBe(true);
			if (!isRecord(parsed.scan)) throw new Error("Missing scan");

			const simulation = parsed.scan.simulation;
			expect(parseSimulationSuccess(simulation)).toBe(true);
			const nativeDiff = readNativeDiff(simulation);
			if (entry.nativeDiff === "negative") {
				expect(nativeDiff < 0n).toBe(true);
			} else if (entry.nativeDiff === "positive") {
				expect(nativeDiff > 0n).toBe(true);
			} else {
				expect(nativeDiff === 0n).toBe(true);
			}

			if (entry.intentIncludes) {
				expect(isString(parsed.scan.intent)).toBe(true);
				if (isString(parsed.scan.intent)) {
					expect(parsed.scan.intent).toContain(entry.intentIncludes);
				}
			}

			if (entry.requireDecodedCalldata) {
				expect(hasFindingCode(parsed.scan.findings, "CALLDATA_DECODED")).toBe(true);
			}
			if (entry.requireCalldataEmpty) {
				expect(hasFindingCode(parsed.scan.findings, "CALLDATA_EMPTY")).toBe(true);
			}
		}, 240000);
	}
});
