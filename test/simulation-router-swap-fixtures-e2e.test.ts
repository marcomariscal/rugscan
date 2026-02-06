import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	isTxFixture,
	runRugscanScanWithTempForkConfig,
	type TxFixture,
} from "./helpers/routerSwapFixtures";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSimulationResult(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && typeof value.success === "boolean";
}

const fixturesDir = fileURLToPath(new URL("./fixtures/txs", import.meta.url));
const anvilPath =
	process.env.RUGSCAN_ANVIL_PATH ?? path.join(os.homedir(), ".foundry", "bin", "anvil");
const forkE2E = process.env.RUGSCAN_FORK_E2E === "1";

const fixtureFiles = readdirSync(fixturesDir)
	.filter((file) => file.endsWith(".json"))
	// This suite only targets router swap fixtures. Approval/lend-borrow fixtures live in the same directory
	// but have a different shape and are covered by their own e2e tests.
	.filter((file) => file.startsWith("uniswap-v4-universalrouter-eth-swap-"))
	.sort();

async function loadFixture(fileName: string): Promise<TxFixture> {
	const fullPath = path.join(fixturesDir, fileName);
	const raw = await Bun.file(fullPath).text();
	const parsed: unknown = JSON.parse(raw);
	if (!isTxFixture(parsed)) {
		throw new Error(`Invalid fixture shape for ${fileName}`);
	}
	return parsed;
}

describe("router swap fixtures e2e", () => {
	for (const fileName of fixtureFiles) {
		const runner = forkE2E && existsSync(anvilPath) ? test : test.skip;
		runner(
			`${fileName} simulates successfully`,
			async () => {
				const fixture = await loadFixture(fileName);
				const result = await runRugscanScanWithTempForkConfig({ fixture, format: "json" });

				expect(result.exitCode).toBe(0);

				let parsed: unknown;
				try {
					parsed = JSON.parse(result.stdout);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(
						`Failed to parse rugscan JSON output (${fixture.name}): ${message}\n` +
							`stdout:\n${result.stdout}\n` +
							`stderr:\n${result.stderr}\n`,
					);
				}

				const scan = isRecord(parsed) ? parsed.scan : undefined;
				const simulation = isRecord(scan) ? scan.simulation : undefined;
				expect(isSimulationResult(simulation)).toBe(true);
				if (!isSimulationResult(simulation)) return;

				expect(simulation.success).toBe(true);

				const nativeDiff = simulation.nativeDiff;
				expect(typeof nativeDiff).toBe("string");
				if (typeof nativeDiff === "string") {
					expect(BigInt(nativeDiff) < 0n).toBe(true);
				}

				const assetChanges = Array.isArray(simulation.assetChanges) ? simulation.assetChanges : [];
				expect(assetChanges.length > 0).toBe(true);

				const erc20In = assetChanges.filter((change: unknown) => {
					if (!isRecord(change)) return false;
					return change.assetType === "erc20" && change.direction === "in";
				});
				expect(erc20In.length > 0).toBe(true);
			},
			180000,
		);
	}
});
