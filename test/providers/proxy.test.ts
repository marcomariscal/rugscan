import { describe, expect, test } from "bun:test";
import { detectProxy } from "../../src/providers/proxy";

describe("proxy detection", () => {
	test("detectProxy identifies EIP-1967 proxies (USDC)", async () => {
		const result = await detectProxy("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "ethereum");

		expect(result.is_proxy).toBe(true);
		expect(result.proxy_type).toBe("eip1967");
		expect(result.implementation).toBeDefined();
	}, 20_000);

	test("detectProxy identifies beacon proxies", async () => {
		const result = await detectProxy("0xca452aff8729c9125ee448e60e8099ff6f4c3cf3", "ethereum");

		expect(result.is_proxy).toBe(true);
		expect(result.proxy_type).toBe("beacon");
		expect(result.implementation).toBeDefined();
	}, 20_000);

	test("detectProxy identifies minimal proxies (EIP-1167)", async () => {
		const result = await detectProxy("0x7768a894e6d0160530c0b386c0a963989239f107", "ethereum");

		expect(result.is_proxy).toBe(true);
		expect(result.proxy_type).toBe("minimal");
		expect(result.implementation).toBeDefined();
	}, 20_000);

	test("detectProxy returns non-proxy for standard contracts", async () => {
		const result = await detectProxy("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "ethereum");

		expect(result.is_proxy).toBe(false);
	}, 20_000);
});
