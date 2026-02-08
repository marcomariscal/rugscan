import { describe, expect, test } from "bun:test";
import { buildSafeIngestPlan } from "../src/safe/ingest";
import { parseSafeMultisigTransaction } from "../src/safe/transaction-service";

const FIXTURE_PATH = "test/fixtures/safe/arb1/cc29eb72/tx.json";

describe("safe ingest (fixture)", () => {
	test("buildSafeIngestPlan decodes delegatecall multiSend batch", async () => {
		const raw = await Bun.file(FIXTURE_PATH).json();
		const tx = parseSafeMultisigTransaction(raw);

		const plan = buildSafeIngestPlan({ tx, chain: "arbitrum" });
		expect(plan.kind).toBe("multisend");
		if (plan.kind !== "multisend") {
			throw new Error("expected multisend plan");
		}

		expect(plan.safe).toBe("0xf3b46870658211414684e061bc1514213e80c49c");
		expect(plan.topLevel.to).toBe("0x9641d764fc13c8b624c04430c7356c1c7c8102e2");
		expect(plan.topLevel.operation).toBe(1);
		expect(plan.callsToAnalyze).toHaveLength(2);
		expect(plan.truncated).toBe(false);

		const [call0, call1] = plan.callsToAnalyze;
		expect(call0.from).toBe("0xf3b46870658211414684e061bc1514213e80c49c");
		expect(call0.chainId).toBe("42161");
		expect(call0.operation).toBe(0);
		expect(call0.to).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
		expect(call0.data.startsWith("0x095ea7b3")).toBe(true);

		expect(call1.from).toBe("0xf3b46870658211414684e061bc1514213e80c49c");
		expect(call1.chainId).toBe("42161");
		expect(call1.operation).toBe(0);
		expect(call1.to).toBe("0x2d2d600cae6d0fcb3f0ecb993736ea4703a2fdd0");
	});
});
