import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const forkConfigPath = fileURLToPath(
	new URL("./fixtures/simulation-forkblock-24379939.json", import.meta.url),
);
const txFixturePath = fileURLToPath(new URL("./fixtures/tx-873d55dd.json", import.meta.url));

describe("simulation fixture e2e", () => {
	test("tx 0x873d55dd… simulates successfully at forkBlock 24379939", async () => {
		if (!existsSync(foundryDefaultAnvilPath)) {
			return;
		}

		const rawFixture = await Bun.file(txFixturePath).text();
		const fixture = JSON.parse(rawFixture);

		const calldata = JSON.stringify({
			to: fixture.to,
			from: fixture.from,
			value: fixture.value,
			data: fixture.data,
			chain: String(fixture.chain),
		});

		const result = await runCli(["scan", "--calldata", calldata, "--format", "json", "--quiet"], {
			RUGSCAN_CONFIG: forkConfigPath,
			NO_COLOR: "1",
			PATH: bunDir,
		});

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		const simulation = parsed?.scan?.simulation;
		expect(simulation).toBeDefined();
		expect(simulation?.success).toBe(true);

		const nativeDiff = simulation?.nativeDiff;
		expect(typeof nativeDiff).toBe("string");
		if (typeof nativeDiff === "string") {
			expect(BigInt(nativeDiff) < 0n).toBe(true);
		}

		const assetChanges = Array.isArray(simulation?.assetChanges) ? simulation.assetChanges : [];
		expect(assetChanges.length > 0).toBe(true);
		const erc20In = assetChanges.filter((change: unknown): change is Record<string, unknown> => {
			if (!isRecord(change)) return false;
			return change.assetType === "erc20" && change.direction === "in";
		});
		expect(erc20In.length > 0).toBe(true);

		const first = erc20In[0];
		const tokenAddress = first?.address;
		expect(typeof tokenAddress).toBe("string");

		const tokenSymbol = first?.symbol;
		expect(typeof tokenSymbol).toBe("string");
		if (typeof tokenSymbol === "string") {
			expect(tokenSymbol.trim().length > 0).toBe(true);
		}
	}, 180000);
});
