import { test as bunTest, describe, expect } from "bun:test";
import { checkVerification } from "../../src/providers/sourcify";

const test = process.env.RUGSCAN_LIVE_TESTS === "1" ? bunTest : bunTest.skip;

describe("sourcify", () => {
	test("checkVerification returns verified contract metadata", async () => {
		const result = await checkVerification(
			"0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
			"ethereum",
		);

		expect(result.verified).toBe(true);
		expect(result.verificationKnown).toBe(true);
		expect(result.source).toBeDefined();
	});

	test("checkVerification returns unverified for contracts without sourcify files", async () => {
		const result = await checkVerification(
			"0x7768a894e6d0160530c0b386c0a963989239f107",
			"ethereum",
		);

		expect(result.verified).toBe(false);
		expect(result.verificationKnown).toBe(true);
		expect(result.source).toBeUndefined();
	});
});
