import { describe, expect, test } from "bun:test";
import { matchProtocol } from "../../src/providers/defillama";

describe("defillama", () => {
	test("matchProtocol identifies Uniswap", async () => {
		const result = await matchProtocol(
			"0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
			"ethereum",
		);

		expect(result).not.toBeNull();
		expect(result?.name.toLowerCase()).toContain("uniswap");
	});

	test("matchProtocol identifies Aave", async () => {
		const result = await matchProtocol(
			"0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
			"ethereum",
		);

		expect(result).not.toBeNull();
		expect(result?.name.toLowerCase()).toContain("aave");
	});

	test("matchProtocol returns null for unknown addresses", async () => {
		const result = await matchProtocol(
			"0xdAC17F958D2ee523a2206206994597C13D831ec7",
			"ethereum",
		);

		expect(result).toBeNull();
	});
});
