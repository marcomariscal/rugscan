import { describe, expect, test } from "bun:test";
import { matchTopProtocolAddress } from "../../src/protocols/top-protocol-registry";

describe("top-protocol-registry", () => {
	describe("ethereum", () => {
		test("Uniswap V2 Router", () => {
			const result = matchTopProtocolAddress(
				"0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap V2");
			expect(result?.slug).toBe("uniswap-v2");
		});

		test("Uniswap V3 SwapRouter", () => {
			const result = matchTopProtocolAddress(
				"0xE592427A0AEce92De3Edee1F18E0157C05861564",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap V3");
		});

		test("Uniswap V3 SwapRouter02", () => {
			const result = matchTopProtocolAddress(
				"0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap V3");
		});

		test("Uniswap Universal Router (legacy)", () => {
			const result = matchTopProtocolAddress(
				"0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap");
		});

		test("Uniswap Universal Router (current)", () => {
			const result = matchTopProtocolAddress(
				"0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap");
		});

		test("Aave V3 Pool", () => {
			const result = matchTopProtocolAddress(
				"0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Aave V3");
			expect(result?.slug).toBe("aave-v3");
		});

		test("Aave V3 Gateway", () => {
			const result = matchTopProtocolAddress(
				"0xd322a49006fc828f9b5b37ab215f99b4e5cab19c",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Aave V3");
		});

		test("Aave V2 Pool", () => {
			const result = matchTopProtocolAddress(
				"0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Aave V2");
		});

		test("Curve 3pool", () => {
			const result = matchTopProtocolAddress(
				"0xbebc44782c7db0a1a60cb6fe97d0e3d5c3c9f0fe",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Curve DEX");
		});

		test("1inch AggregationRouter V5", () => {
			const result = matchTopProtocolAddress(
				"0x1111111254eeb25477b68fb85ed929f73a960582",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("1inch");
			expect(result?.slug).toBe("1inch-network");
		});

		test("1inch AggregationRouter V6", () => {
			const result = matchTopProtocolAddress(
				"0x111111125421ca6dc452d289314280a0f8842a65",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("1inch");
		});

		test("Balancer V2 Vault", () => {
			const result = matchTopProtocolAddress(
				"0xba12222222228d8ba445958a75a0704d566bf2c8",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Balancer V2");
			expect(result?.slug).toBe("balancer-v2");
		});

		test("CoW Protocol GPv2Settlement", () => {
			const result = matchTopProtocolAddress(
				"0x9008d19f58aabd9ed0d60971565aa8510560ab41",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("CoW Protocol");
			expect(result?.slug).toBe("cow-protocol");
		});

		test("0x Exchange Proxy", () => {
			const result = matchTopProtocolAddress(
				"0xdef1c0ded9bec7f1a1670819833240f027b25eff",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("0x Protocol");
			expect(result?.slug).toBe("0x-protocol");
		});

		test("Morpho Blue", () => {
			const result = matchTopProtocolAddress(
				"0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Morpho");
			expect(result?.slug).toBe("morpho-blue");
		});

		test("Seaport 1.5", () => {
			const result = matchTopProtocolAddress(
				"0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("OpenSea Seaport");
		});

		test("Seaport 1.6", () => {
			const result = matchTopProtocolAddress(
				"0x0000000000000068f116a894984e2db1123eb395",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("OpenSea Seaport");
		});

		test("WETH", () => {
			const result = matchTopProtocolAddress(
				"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("WETH");
		});

		test("Circle USDC", () => {
			const result = matchTopProtocolAddress(
				"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Circle USDC");
		});

		test("Tether USDT", () => {
			const result = matchTopProtocolAddress(
				"0xdac17f958d2ee523a2206206994597c13d831ec7",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Tether USDT");
		});

		test("Lido stETH", () => {
			const result = matchTopProtocolAddress(
				"0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Lido");
		});

		test("Compound Comptroller", () => {
			const result = matchTopProtocolAddress(
				"0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Compound");
		});

		test("Cap proxy", () => {
			const result = matchTopProtocolAddress(
				"0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Cap");
		});

		test("Cap implementation", () => {
			const result = matchTopProtocolAddress(
				"0xdb549616407f8a30799f77f12b6b85aec936782d",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Cap");
		});

		test("ether.fi weETH adapter proxy", () => {
			const result = matchTopProtocolAddress(
				"0xcfc6d9bd7411962bfe7145451a7ef71a24b6a7a2",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("ether.fi/weETH adapter");
		});

		test("ether.fi weETH adapter impl", () => {
			const result = matchTopProtocolAddress(
				"0xe87797a1afb329216811dfa22c87380128ca17d8",
				"ethereum",
			);
			expect(result).not.toBeNull();
			expect(result?.name).toBe("ether.fi/weETH adapter");
		});
	});

	describe("base", () => {
		test("Uniswap V2 Router", () => {
			const result = matchTopProtocolAddress("0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24", "base");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap V2");
		});

		test("Uniswap V3 SwapRouter02", () => {
			const result = matchTopProtocolAddress("0x2626664c2603336e57b271c5c0b26f421741e481", "base");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap V3");
		});

		test("Uniswap Universal Router", () => {
			const result = matchTopProtocolAddress("0x6ff5693b99212da76ad316178a184ab56d299b43", "base");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap");
		});

		test("Permit2 on Base", () => {
			const result = matchTopProtocolAddress("0x000000000022d473030f116ddee9f6b43ac78ba3", "base");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Uniswap Permit2");
		});

		test("QuickSwap on Base", () => {
			const result = matchTopProtocolAddress("0x4a012af2b05616fb390ed32452641c3f04633bb5", "base");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("QuickSwap");
		});

		test("WETH on Base", () => {
			const result = matchTopProtocolAddress("0x4200000000000000000000000000000000000006", "base");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("WETH");
		});

		test("USDC on Base", () => {
			const result = matchTopProtocolAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "base");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Circle USDC");
		});
	});

	describe("cross-chain isolation", () => {
		test("ethereum-only address returns null on base", () => {
			const result = matchTopProtocolAddress("0xba12222222228d8ba445958a75a0704d566bf2c8", "base");
			expect(result).toBeNull();
		});

		test("base-only address returns null on ethereum", () => {
			const result = matchTopProtocolAddress(
				"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
				"ethereum",
			);
			expect(result).toBeNull();
		});
	});

	describe("negative cases", () => {
		test("dead address returns null", () => {
			const result = matchTopProtocolAddress(
				"0x000000000000000000000000000000000000dead",
				"ethereum",
			);
			expect(result).toBeNull();
		});

		test("invalid address returns null", () => {
			const result = matchTopProtocolAddress("not-an-address", "ethereum");
			expect(result).toBeNull();
		});

		test("case-insensitive matching", () => {
			const lower = matchTopProtocolAddress(
				"0xba12222222228d8ba445958a75a0704d566bf2c8",
				"ethereum",
			);
			const upper = matchTopProtocolAddress(
				"0xBA12222222228D8BA445958A75A0704D566BF2C8",
				"ethereum",
			);
			expect(lower).not.toBeNull();
			expect(upper).not.toBeNull();
			expect(lower?.name).toBe(upper?.name);
		});
	});
});
