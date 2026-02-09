import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config";

function setEnv(key: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}

describe("config", () => {
	test("env overrides config file etherscan key", async () => {
		const tempPath = path.join(os.tmpdir(), `assay-config-${Date.now()}.json`);
		await writeFile(
			tempPath,
			JSON.stringify({
				etherscanKeys: {
					ethereum: "file-key",
				},
			}),
		);

		const previous = {
			ASSAY_CONFIG: process.env.ASSAY_CONFIG,
			ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
		};

		try {
			setEnv("ASSAY_CONFIG", tempPath);
			setEnv("ETHERSCAN_API_KEY", "env-key");

			const config = await loadConfig();
			expect(config.etherscanKeys?.ethereum).toBe("env-key");
		} finally {
			setEnv("ASSAY_CONFIG", previous.ASSAY_CONFIG);
			setEnv("ETHERSCAN_API_KEY", previous.ETHERSCAN_API_KEY);
			await rm(tempPath, { force: true });
		}
	});

	test("single ETHERSCAN_API_KEY is used as fallback for non-mainnet chains", async () => {
		const previous = {
			ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
			BASESCAN_API_KEY: process.env.BASESCAN_API_KEY,
			ARBISCAN_API_KEY: process.env.ARBISCAN_API_KEY,
		};

		try {
			setEnv("ETHERSCAN_API_KEY", "shared-key");
			setEnv("BASESCAN_API_KEY", undefined);
			setEnv("ARBISCAN_API_KEY", "arb-override");

			const config = await loadConfig();
			expect(config.etherscanKeys?.ethereum).toBe("shared-key");
			expect(config.etherscanKeys?.base).toBe("shared-key");
			expect(config.etherscanKeys?.arbitrum).toBe("arb-override");
		} finally {
			setEnv("ETHERSCAN_API_KEY", previous.ETHERSCAN_API_KEY);
			setEnv("BASESCAN_API_KEY", previous.BASESCAN_API_KEY);
			setEnv("ARBISCAN_API_KEY", previous.ARBISCAN_API_KEY);
		}
	});
});
