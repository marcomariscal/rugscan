import { describe, expect, test } from "bun:test";
import { loadSafeMultisigTransaction } from "../src/safe/load";

const SAFE_TX_HASH = "0xcc29eb7274575a6f5ff90a15f0ecc267bb8f8253feb1f659c828ef09e5bc4152";
const FIXTURE_PATH = "test/fixtures/safe/arb1/cc29eb72/tx.json";

describe("safe fixture loader (unit)", () => {
	test("--safe-tx-json path bypasses Safe API fetch", async () => {
		let called = 0;
		const fetchFn: typeof fetch = async () => {
			called += 1;
			throw new Error("fetch should not be called");
		};

		const tx = await loadSafeMultisigTransaction({
			chain: "arbitrum",
			safeTxHash: SAFE_TX_HASH,
			offline: false,
			safeTxJsonPath: FIXTURE_PATH,
			fetchFn,
		});

		expect(called).toBe(0);
		expect(tx.safe.toLowerCase()).toBe("0xf3b46870658211414684e061bc1514213e80c49c");
		expect(tx.operation).toBe(1);
	});

	test("offline mode hard-errors without --safe-tx-json (no Safe API fetch)", async () => {
		let called = 0;
		const fetchFn: typeof fetch = async () => {
			called += 1;
			throw new Error("fetch should not be called");
		};

		let threw = false;
		try {
			await loadSafeMultisigTransaction({
				chain: "arbitrum",
				safeTxHash: SAFE_TX_HASH,
				offline: true,
				fetchFn,
			});
		} catch (error) {
			threw = true;
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toBe("offline mode: provide --safe-tx-json (no Safe API fetch)");
		}

		expect(threw).toBe(true);
		expect(called).toBe(0);
	});
});
