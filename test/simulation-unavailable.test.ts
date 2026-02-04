import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { simulateBalance } from "../src/simulations/balance";

describe("simulateBalance", () => {
	test("missing anvil returns simulation not run with Foundry hint", async () => {
		const result = await simulateBalance(
			{
				to: "0x1111111111111111111111111111111111111111",
				from: "0x2222222222222222222222222222222222222222",
				data: "0x",
				value: "0x0",
				chain: "1",
			},
			"ethereum",
			{
				simulation: {
					enabled: true,
					anvilPath: "__definitely_not_anvil__",
				},
			},
		);

		expect(result.success).toBe(false);
		expect(result.revertReason).toBe("Simulation not run");
		const notes = result.notes.join("\n");
		expect(notes).toContain("Anvil not found");
		expect(notes).toContain("Foundry");
	});

	test("auto-detect missing anvil mentions search locations", async () => {
		const originalHome = process.env.HOME;
		const originalPath = process.env.PATH;

		const tmpHome = mkdtempSync(path.join(os.tmpdir(), "rugscan-home-"));
		process.env.HOME = tmpHome;
		process.env.PATH = tmpHome;

		try {
			const result = await simulateBalance(
				{
					to: "0x1111111111111111111111111111111111111111",
					from: "0x2222222222222222222222222222222222222222",
					data: "0x",
					value: "0",
					chain: "1",
				},
				"ethereum",
				{ simulation: { enabled: true } },
			);

			expect(result.success).toBe(false);
			expect(result.revertReason).toBe("Simulation not run");
			const notes = result.notes.join("\n");
			expect(notes).toContain("Anvil not found");
			expect(notes).toContain(path.join(tmpHome, ".foundry", "bin", "anvil"));
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
		}
	});
});
