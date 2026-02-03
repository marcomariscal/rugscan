import { describe, expect, test } from "bun:test";
import { resolveContractName } from "../src/name-resolution";

describe("name resolution", () => {
	test("prefers protocol + implementation name for proxies", () => {
		const result = resolveContractName({
			address: "0xabc",
			isProxy: true,
			proxyName: "InitializableAdminUpgradeabilityProxy",
			implementationName: "Pool",
			protocolName: "Aave V3",
		});

		expect(result.resolvedName).toBe("Aave V3 Pool");
	});

	test("falls back to implementation name for proxies", () => {
		const result = resolveContractName({
			address: "0xabc",
			isProxy: true,
			proxyName: "Proxy",
			implementationName: "Pool",
		});

		expect(result.resolvedName).toBe("Pool");
	});

	test("falls back to proxy name when implementation is missing", () => {
		const result = resolveContractName({
			address: "0xabc",
			isProxy: true,
			proxyName: "Proxy",
		});

		expect(result.resolvedName).toBe("Proxy");
	});

	test("falls back to address when no names are available", () => {
		const result = resolveContractName({
			address: "0xabc",
			isProxy: true,
		});

		expect(result.resolvedName).toBe("0xabc");
	});

	test("does not override non-proxy contract names with protocol", () => {
		const result = resolveContractName({
			address: "0xabc",
			isProxy: false,
			proxyName: "TetherToken",
			protocolName: "Aave",
		});

		expect(result.resolvedName).toBe("TetherToken");
	});

	test("uses protocol name for non-proxy when contract name is missing", () => {
		const result = resolveContractName({
			address: "0xabc",
			isProxy: false,
			protocolName: "Uniswap",
		});

		expect(result.resolvedName).toBe("Uniswap");
	});

	test("avoids duplicating protocol name", () => {
		const result = resolveContractName({
			address: "0xabc",
			isProxy: true,
			implementationName: "UniswapV3Pool",
			protocolName: "Uniswap",
		});

		expect(result.resolvedName).toBe("UniswapV3Pool");
	});
});
