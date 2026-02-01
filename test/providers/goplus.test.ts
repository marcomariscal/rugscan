import { describe, expect, test } from "bun:test";
import { getTokenSecurity } from "../../src/providers/goplus";

describe("goplus", () => {
	test("getTokenSecurity flags honeypot tokens", async () => {
		const result = await getTokenSecurity(
			"0x208042a2012812f189e4e696e05f08eadb883404",
			"ethereum",
		);

		expect(result.data).not.toBeNull();
		expect(result.data?.is_honeypot).toBe(true);
	});

	test("getTokenSecurity flags mintable + blacklist risk (USDT)", async () => {
		const result = await getTokenSecurity(
			"0xdAC17F958D2ee523a2206206994597C13D831ec7",
			"ethereum",
		);

		expect(result.data).not.toBeNull();
		expect(result.data?.is_mintable).toBe(true);
		expect(result.data?.is_blacklisted).toBe(true);
		expect(result.data?.owner_can_change_balance).toBe(true);
	});

	test("getTokenSecurity returns tax rates when present", async () => {
		const result = await getTokenSecurity(
			"0xfad45e47083e4607302aa43c65fb3106f1cd7607",
			"ethereum",
		);

		expect(result.data).not.toBeNull();
		expect(result.data?.buy_tax).toBeGreaterThan(0);
		expect(result.data?.sell_tax).toBeGreaterThan(0);
	});
});
