import { describe, expect, test } from "bun:test";
import { createSafeTxServiceClient } from "../src/safe/transaction-service";

const SAFE_TX_HASH = "0xcc29eb7274575a6f5ff90a15f0ecc267bb8f8253feb1f659c828ef09e5bc4152";
const FIXTURE_PATH = "test/fixtures/safe/arb1/cc29eb72/tx.json";

describe("safe transaction service (fixture)", () => {
	test("client parses a multisig transaction response", async () => {
		const expectedUrl = `https://api.safe.global/tx-service/arb1/api/v1/multisig-transactions/${SAFE_TX_HASH}/`;

		let called = 0;
		const fetchFn: typeof fetch = async (input) => {
			called += 1;
			expect(String(input)).toBe(expectedUrl);

			const json = await Bun.file(FIXTURE_PATH).json();
			return new Response(JSON.stringify(json), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const client = createSafeTxServiceClient({ fetchFn });
		const tx = await client.fetchMultisigTransaction({
			safeTxHash: SAFE_TX_HASH,
			chain: "arbitrum",
		});

		expect(called).toBe(1);
		expect(tx.safe.toLowerCase()).toBe("0xf3b46870658211414684e061bc1514213e80c49c");
		expect(tx.operation).toBe(1);
		expect(tx.to.toLowerCase()).toBe("0x9641d764fc13c8b624c04430c7356c1c7c8102e2");
		// multisend calldata should be present
		expect(tx.data?.startsWith("0x")).toBe(true);
	});
});
