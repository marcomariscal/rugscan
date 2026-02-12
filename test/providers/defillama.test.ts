import { test as bunTest, describe, expect } from "bun:test";
import { matchProtocol } from "../../src/providers/defillama";

const test = process.env.ASSAY_LIVE_TESTS === "1" ? bunTest : bunTest.skip;

describe("defillama", () => {
	bunTest("manual 1inch router fixture resolves without network lookup", async () => {
		const result = await matchProtocol("0x1111111254fb6c44bac0bed2854e76f90643097d", "ethereum", {
			allowNetwork: false,
		});

		expect(result).not.toBeNull();
		expect(result?.name).toBe("1inch");
		if (!result) return;
		expect(result.slug).toBe("1inch-network");
	});

	test("matchProtocol identifies Uniswap", async () => {
		const result = await matchProtocol("0xe592427a0aece92de3edee1f18e0157c05861564", "ethereum");

		expect(result).not.toBeNull();
		expect(result?.name.toLowerCase()).toContain("uniswap");
	});

	test("matchProtocol identifies Aave", async () => {
		const result = await matchProtocol("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", "ethereum");

		expect(result).not.toBeNull();
		expect(result?.name.toLowerCase()).toContain("aave");
	});

	test("matchProtocol identifies Curve", async () => {
		const result = await matchProtocol("0xbEbc44782C7dB0a1A60Cb6fe97d0E3D5C3c9F0FE", "ethereum");

		expect(result).not.toBeNull();
		expect(result?.name.toLowerCase()).toContain("curve");
	});

	test("matchProtocol returns null for unknown addresses", async () => {
		const result = await matchProtocol("0x000000000000000000000000000000000000dEaD", "ethereum");

		expect(result).toBeNull();
	});
});
