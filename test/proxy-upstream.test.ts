import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	formatMissingUpstreamError,
	RUGSCAN_UPSTREAM_ENV,
	resolveProxyUpstreamUrl,
} from "../src/cli/proxy-upstream";
import { saveRpcUrl } from "../src/config";

function setEnv(key: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}

describe("rugscan proxy upstream", () => {
	test("resolution order: cli > env > config", () => {
		const config = {
			rpcUrls: {
				ethereum: "https://config.example",
			},
		};

		const withCli = resolveProxyUpstreamUrl({
			cliUpstream: "https://cli.example",
			chainArg: "1",
			config,
			envUpstream: "https://env.example",
		});
		expect(withCli?.upstreamUrl).toBe("https://cli.example");
		expect(withCli?.source).toBe("cli");

		const withEnv = resolveProxyUpstreamUrl({
			cliUpstream: undefined,
			chainArg: "1",
			config,
			envUpstream: "https://env.example",
		});
		expect(withEnv?.upstreamUrl).toBe("https://env.example");
		expect(withEnv?.source).toBe("env");

		const withConfig = resolveProxyUpstreamUrl({
			cliUpstream: undefined,
			chainArg: "1",
			config,
			envUpstream: undefined,
		});
		expect(withConfig?.upstreamUrl).toBe("https://config.example");
		expect(withConfig?.source).toBe("config");
	});

	test("missing upstream error message shows env var + config path", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "rugscan-upstream-"));
		const tempConfigPath = path.join(tempDir, "config.json");

		const previous = {
			RUGSCAN_CONFIG: process.env.RUGSCAN_CONFIG,
		};

		try {
			setEnv("RUGSCAN_CONFIG", tempConfigPath);

			const message = formatMissingUpstreamError({ chainArg: "ethereum" });
			expect(message).toContain(RUGSCAN_UPSTREAM_ENV);
			expect(message).toContain(tempConfigPath);
			expect(message).toContain("rpcUrls");
		} finally {
			setEnv("RUGSCAN_CONFIG", previous.RUGSCAN_CONFIG);
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("--save persists rpcUrls.ethereum without clobbering other keys", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "rugscan-save-"));
		const tempConfigPath = path.join(tempDir, "config.json");

		const previous = {
			RUGSCAN_CONFIG: process.env.RUGSCAN_CONFIG,
		};

		try {
			setEnv("RUGSCAN_CONFIG", tempConfigPath);

			await writeFile(
				tempConfigPath,
				JSON.stringify(
					{
						etherscanKeys: { ethereum: "existing-etherscan" },
						rpcUrls: { ethereum: "https://existing.example" },
					},
					null,
					2,
				),
			);

			const writtenPath = await saveRpcUrl({
				chain: "ethereum",
				rpcUrl: "https://new-eth.example",
			});
			expect(writtenPath).toBe(tempConfigPath);

			const raw = await readFile(tempConfigPath, "utf-8");
			const parsed: unknown = JSON.parse(raw);

			const isRecord = (value: unknown): value is Record<string, unknown> =>
				typeof value === "object" && value !== null;

			if (!isRecord(parsed)) {
				throw new Error("expected config to be an object");
			}

			expect(parsed.etherscanKeys).toBeDefined();
			expect(parsed.rpcUrls).toBeDefined();

			const rpcUrls = parsed.rpcUrls;
			if (!isRecord(rpcUrls)) {
				throw new Error("expected rpcUrls to be an object");
			}

			expect(rpcUrls.ethereum).toBe("https://new-eth.example");
		} finally {
			setEnv("RUGSCAN_CONFIG", previous.RUGSCAN_CONFIG);
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
