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
		const tempPath = path.join(os.tmpdir(), `rugscan-config-${Date.now()}.json`);
		await writeFile(
			tempPath,
			JSON.stringify({
				etherscanKeys: {
					ethereum: "file-key",
				},
			}),
		);

		const previous = {
			RUGSCAN_CONFIG: process.env.RUGSCAN_CONFIG,
			ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
		};

		try {
			setEnv("RUGSCAN_CONFIG", tempPath);
			setEnv("ETHERSCAN_API_KEY", "env-key");

			const config = await loadConfig();
			expect(config.etherscanKeys?.ethereum).toBe("env-key");
		} finally {
			setEnv("RUGSCAN_CONFIG", previous.RUGSCAN_CONFIG);
			setEnv("ETHERSCAN_API_KEY", previous.ETHERSCAN_API_KEY);
			await rm(tempPath, { force: true });
		}
	});
});
