import { describe, expect, test } from "bun:test";
import {
	inferProtocolFallback,
	inferProtocolFromKnownSpenderName,
} from "../../src/protocols/fallback-heuristics";

describe("fallback-heuristics", () => {
	describe("inferProtocolFallback — registry hit (passthrough)", () => {
		test("Balancer V2 Vault resolves from registry", () => {
			const result = inferProtocolFallback({
				address: "0xba12222222228d8ba445958a75a0704d566bf2c8",
				chain: "ethereum",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Balancer V2");
		});
	});

	describe("inferProtocolFromKnownSpenderName — name-based heuristic", () => {
		test("SushiSwap Router spender resolves via name heuristic", () => {
			const result = inferProtocolFromKnownSpenderName(
				"0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("SushiSwap");
		});

		test("Uniswap V2 Router spender resolves via name heuristic", () => {
			const result = inferProtocolFromKnownSpenderName(
				"0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap");
		});

		test("Uniswap Permit2 spender resolves via name heuristic", () => {
			const result = inferProtocolFromKnownSpenderName(
				"0x000000000022d473030f116ddee9f6b43ac78ba3",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap");
		});

		test("1inch Router spender resolves via name heuristic", () => {
			const result = inferProtocolFromKnownSpenderName(
				"0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("1inch");
		});

		test("unknown address returns null", () => {
			const result = inferProtocolFromKnownSpenderName(
				"0x000000000000000000000000000000000000dead",
				"ethereum",
			);
			expect(result).toBeNull();
		});
	});

	describe("inferProtocolFallback — implementation name heuristic", () => {
		test("implementation name containing 'AavePool' resolves to Aave", () => {
			const result = inferProtocolFallback({
				address: "0x0000000000000000000000000000000000001234",
				chain: "ethereum",
				implementationName: "AavePoolV3",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Aave");
		});

		test("implementation name containing 'UniswapV3Pool' resolves to Uniswap", () => {
			const result = inferProtocolFallback({
				address: "0x0000000000000000000000000000000000001234",
				chain: "ethereum",
				implementationName: "UniswapV3Pool",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap");
		});

		test("implementation name containing 'CurveStableSwap' resolves to Curve", () => {
			const result = inferProtocolFallback({
				address: "0x0000000000000000000000000000000000001234",
				chain: "ethereum",
				implementationName: "CurveStableSwap",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Curve");
		});

		test("implementation name containing 'BalancerVault' resolves to Balancer", () => {
			const result = inferProtocolFallback({
				address: "0x0000000000000000000000000000000000001234",
				chain: "ethereum",
				implementationName: "BalancerVault",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Balancer");
		});

		test("implementation name containing 'Seaport' resolves to OpenSea Seaport", () => {
			const result = inferProtocolFallback({
				address: "0x0000000000000000000000000000000000001234",
				chain: "ethereum",
				implementationName: "SeaportConduitController",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("OpenSea Seaport");
		});

		test("implementation name containing 'MorphoBlue' resolves to Morpho", () => {
			const result = inferProtocolFallback({
				address: "0x0000000000000000000000000000000000001234",
				chain: "ethereum",
				implementationName: "MorphoBlueIRM",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Morpho");
		});

		test("implementation name containing 'CompoundComptroller' resolves to Compound", () => {
			const result = inferProtocolFallback({
				address: "0x0000000000000000000000000000000000001234",
				chain: "ethereum",
				implementationName: "CompoundComptroller",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Compound");
		});

		test("implementation name containing 'Lido' resolves to Lido", () => {
			const result = inferProtocolFallback({
				address: "0x0000000000000000000000000000000000001234",
				chain: "ethereum",
				implementationName: "LidoStETH",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Lido");
		});

		test("proxy name fallback: 'GPv2Settlement' resolves to CoW Protocol", () => {
			const result = inferProtocolFallback({
				address: "0x0000000000000000000000000000000000001234",
				chain: "ethereum",
				proxyName: "GPv2Settlement",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("CoW Protocol");
		});

		test("proxy name fallback: 'ZeroExProxy' resolves to 0x Protocol", () => {
			const result = inferProtocolFallback({
				address: "0x0000000000000000000000000000000000001234",
				chain: "ethereum",
				proxyName: "ZeroExProxy",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("0x Protocol");
		});
	});

	describe("inferProtocolFallback — no match", () => {
		test("unknown address with no names returns null", () => {
			const result = inferProtocolFallback({
				address: "0x000000000000000000000000000000000000dead",
				chain: "ethereum",
			});
			expect(result).toBeNull();
		});

		test("unknown implementation name returns null", () => {
			const result = inferProtocolFallback({
				address: "0x000000000000000000000000000000000000dead",
				chain: "ethereum",
				implementationName: "SomeRandomContract",
			});
			expect(result).toBeNull();
		});
	});

	describe("inferProtocolFallback — priority order", () => {
		test("registry match takes priority over name heuristic", () => {
			// Aave V3 Pool is in the registry — even with a misleading impl name,
			// the registry match wins.
			const result = inferProtocolFallback({
				address: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
				chain: "ethereum",
				implementationName: "CurveFakeDecoy",
			});
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Aave V3");
		});
	});
});
