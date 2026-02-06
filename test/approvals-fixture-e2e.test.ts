import { test as bunTest, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const test = process.env.RUGSCAN_FORK_E2E === "1" ? bunTest : bunTest.skip;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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

const bunDir = path.dirname(process.execPath);
const foundryDefaultAnvilPath = path.join(os.homedir(), ".foundry", "bin", "anvil");
const anvilDir = path.dirname(foundryDefaultAnvilPath);

const fixturesDir = path.join(import.meta.dir, "fixtures", "txs");

interface TxFixture {
	chain: number;
	to: string;
	from: string;
	value: string;
	data: string;
	forkBlock: number;
	txHash: string;
	txBlock: number;
}

function parseFixture(value: unknown): TxFixture {
	if (!isRecord(value)) {
		throw new Error("Invalid fixture: expected object");
	}
	const chain = value.chain;
	const to = value.to;
	const from = value.from;
	const valueStr = value.value;
	const data = value.data;
	const forkBlock = value.forkBlock;
	const txHash = value.txHash;
	const txBlock = value.txBlock;

	if (typeof chain !== "number") throw new Error("Invalid fixture.chain");
	if (typeof to !== "string") throw new Error("Invalid fixture.to");
	if (typeof from !== "string") throw new Error("Invalid fixture.from");
	if (typeof valueStr !== "string") throw new Error("Invalid fixture.value");
	if (typeof data !== "string") throw new Error("Invalid fixture.data");
	if (typeof forkBlock !== "number") throw new Error("Invalid fixture.forkBlock");
	if (typeof txHash !== "string") throw new Error("Invalid fixture.txHash");
	if (typeof txBlock !== "number") throw new Error("Invalid fixture.txBlock");

	return {
		chain,
		to,
		from,
		value: valueStr,
		data,
		forkBlock,
		txHash,
		txBlock,
	};
}

async function runScanForFixture(fixture: TxFixture) {
	const calldata = JSON.stringify({
		to: fixture.to,
		from: fixture.from,
		value: fixture.value,
		data: fixture.data,
		chain: String(fixture.chain),
	});

	const configPath = path.join(
		os.tmpdir(),
		`rugscan-test-sim-${fixture.txHash.slice(0, 10)}-${Date.now()}.json`,
	);
	await Bun.write(
		configPath,
		JSON.stringify({ simulation: { enabled: true, forkBlock: fixture.forkBlock } }),
	);

	const result = await runCli(
		["scan", "--calldata", calldata, "--format", "json", "--fail-on", "danger", "--quiet"],
		{
			RUGSCAN_CONFIG: configPath,
			NO_COLOR: "1",
			PATH: `${anvilDir}:${bunDir}:${process.env.PATH ?? ""}`,
		},
	);

	// The CLI uses a non-zero exit code for warning/danger recommendations. We still want to
	// assert the simulation + approvals output.
	expect(result.exitCode === 0 || result.exitCode === 2).toBe(true);

	const parsed = JSON.parse(result.stdout);
	const simulation = parsed?.scan?.simulation;
	expect(simulation).toBeDefined();
	expect(simulation?.success).toBe(true);

	return { simulation };
}

describe("approvals fixture e2e", () => {
	test("detects approvals from mainnet fixtures", async () => {
		if (!existsSync(foundryDefaultAnvilPath)) {
			return;
		}

		const fixtureFiles: Array<{ file: string; expected: Record<string, unknown> }> = [
			{
				file: "permit2-approve-usdc-unlimited.json",
				expected: {
					standard: "permit2",
					token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
					spender: "0x9999999999999999999999999999999999999999",
					amount: "1461501637330902918203684832716283019655932542975",
					scope: "token",
				},
			},
			{
				file: "erc20-approve-usdc-limited.json",
				expected: {
					standard: "erc20",
					token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
					spender: "0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146",
					amount: "500606000",
					scope: "token",
				},
			},
			{
				file: "erc20-approve-usdc-permit2-max.json",
				expected: {
					standard: "erc20",
					token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
					spender: "0x000000000022d473030f116ddee9f6b43ac78ba3",
					amount: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
					scope: "token",
				},
			},
			{
				file: "erc721-approval-for-all-ens-opensea-true.json",
				expected: {
					standard: "erc721",
					token: "0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85",
					spender: "0x1e0049783f008a0085193e00003d00cd54003c71",
					scope: "all",
					approved: true,
				},
			},
			{
				file: "erc721-approval-for-all-ens-revoke-false.json",
				expected: {
					standard: "erc721",
					token: "0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85",
					spender: "0xf42aa99f011a1fa7cda90e5e98b277e306bca83e",
					scope: "all",
					approved: false,
				},
			},
			{
				file: "erc1155-approval-for-all-mirror-mnfts-opensea-true.json",
				expected: {
					standard: "erc1155",
					token: "0x84162fe2e695fedbf4d3bca1c3458fb616e44735",
					spender: "0x1e0049783f008a0085193e00003d00cd54003c71",
					scope: "all",
					approved: true,
				},
			},
		];

		for (const entry of fixtureFiles) {
			const raw = await Bun.file(path.join(fixturesDir, entry.file)).text();
			const fixture = parseFixture(JSON.parse(raw));
			const { simulation } = await runScanForFixture(fixture);

			const approvals = Array.isArray(simulation?.approvals) ? simulation.approvals : [];
			expect(approvals.length > 0).toBe(true);

			const expectedToken = String(entry.expected.token).toLowerCase();
			const expectedSpender = String(entry.expected.spender).toLowerCase();

			const match = approvals.find((approval: unknown) => {
				if (!isRecord(approval)) return false;
				if (approval.standard !== entry.expected.standard) return false;
				if (typeof approval.token !== "string") return false;
				if (approval.token.toLowerCase() !== expectedToken) return false;
				if (typeof approval.spender !== "string") return false;
				if (approval.spender.toLowerCase() !== expectedSpender) return false;
				if ("amount" in entry.expected && approval.amount !== entry.expected.amount) return false;
				if ("scope" in entry.expected && approval.scope !== entry.expected.scope) return false;
				if ("approved" in entry.expected && approval.approved !== entry.expected.approved)
					return false;
				return true;
			});

			expect(match).toBeDefined();
		}
	}, 240000);
});
