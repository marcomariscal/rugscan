import type { Chain, ProtocolMatch } from "../types";

interface ProtocolEntry {
	match: {
		name: string;
		slug: string;
	};
	roots: Partial<Record<Chain, readonly string[]>>;
}

const TOP_PROTOCOL_REGISTRY: readonly ProtocolEntry[] = [
	{
		match: { name: "Uniswap V2", slug: "uniswap-v2" },
		roots: {
			ethereum: ["0x7a250d5630b4cf539739df2c5dacb4c659f2488d"],
			base: ["0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24"],
		},
	},
	{
		match: { name: "Uniswap V3", slug: "uniswap-v3" },
		roots: {
			ethereum: [
				"0xe592427a0aece92de3edee1f18e0157c05861564",
				"0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
			],
			base: ["0x2626664c2603336e57b271c5c0b26f421741e481"],
		},
	},
	{
		match: { name: "Uniswap", slug: "uniswap" },
		roots: {
			ethereum: [
				"0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
				"0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
			],
			base: ["0x6ff5693b99212da76ad316178a184ab56d299b43"],
		},
	},
	{
		match: { name: "Uniswap Permit2", slug: "uniswap-permit2" },
		roots: {
			base: ["0x000000000022d473030f116ddee9f6b43ac78ba3"],
		},
	},
	{
		match: { name: "Aave V3", slug: "aave-v3" },
		roots: {
			ethereum: [
				"0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
				"0xd322a49006fc828f9b5b37ab215f99b4e5cab19c",
			],
		},
	},
	{
		match: { name: "Aave V2", slug: "aave-v2" },
		roots: {
			ethereum: ["0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9"],
		},
	},
	{
		match: { name: "Curve DEX", slug: "curve-dex" },
		roots: {
			ethereum: [
				"0xbebc44782c7db0a1a60cb6fe97d0e3d5c3c9f0fe",
				"0x99a58482bd75cbab83b27ec03ca68ff489b5788f",
			],
		},
	},
	{
		match: { name: "1inch", slug: "1inch-network" },
		roots: {
			ethereum: [
				"0x1111111254eeb25477b68fb85ed929f73a960582",
				"0x1111111254fb6c44bac0bed2854e76f90643097d",
				"0x111111125421ca6dc452d289314280a0f8842a65",
			],
		},
	},
	{
		match: { name: "Balancer V2", slug: "balancer-v2" },
		roots: {
			ethereum: ["0xba12222222228d8ba445958a75a0704d566bf2c8"],
		},
	},
	{
		match: { name: "CoW Protocol", slug: "cow-protocol" },
		roots: {
			ethereum: ["0x9008d19f58aabd9ed0d60971565aa8510560ab41"],
		},
	},
	{
		match: { name: "0x Protocol", slug: "0x-protocol" },
		roots: {
			ethereum: ["0xdef1c0ded9bec7f1a1670819833240f027b25eff"],
		},
	},
	{
		match: { name: "Morpho", slug: "morpho-blue" },
		roots: {
			ethereum: ["0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"],
		},
	},
	{
		match: { name: "OpenSea Seaport", slug: "opensea-seaport" },
		roots: {
			ethereum: [
				"0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
				"0x0000000000000068f116a894984e2db1123eb395",
			],
		},
	},
	{
		match: { name: "QuickSwap", slug: "quickswap-dex" },
		roots: {
			base: ["0x4a012af2b05616fb390ed32452641c3f04633bb5"],
		},
	},
	{
		match: { name: "WETH", slug: "weth" },
		roots: {
			ethereum: ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
			base: ["0x4200000000000000000000000000000000000006"],
		},
	},
	{
		match: { name: "Circle USDC", slug: "circle" },
		roots: {
			ethereum: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
			base: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
		},
	},
	{
		match: { name: "Tether USDT", slug: "tether" },
		roots: {
			ethereum: ["0xdac17f958d2ee523a2206206994597c13d831ec7"],
		},
	},
	{
		match: { name: "Lido", slug: "lido" },
		roots: {
			ethereum: ["0xae7ab96520de3a18e5e111b5eaab095312d7fe84"],
		},
	},
	{
		match: { name: "Compound", slug: "compound-finance" },
		roots: {
			ethereum: ["0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b"],
		},
	},
	{
		match: { name: "Cap", slug: "cap" },
		roots: {
			ethereum: [
				"0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
				"0xdb549616407f8a30799f77f12b6b85aec936782d",
			],
		},
	},
	{
		match: { name: "ether.fi/weETH adapter", slug: "ether-fi-weeth-adapter" },
		roots: {
			ethereum: [
				"0xcfc6d9bd7411962bfe7145451a7ef71a24b6a7a2",
				"0xe87797a1afb329216811dfa22c87380128ca17d8",
			],
		},
	},
] as const;

const CHAIN_ORDER: readonly Chain[] = ["ethereum", "base", "arbitrum", "optimism", "polygon"];

const TOP_PROTOCOL_INDEX = buildProtocolAddressIndex(TOP_PROTOCOL_REGISTRY);

export function matchTopProtocolAddress(address: string, chain: Chain): ProtocolMatch | null {
	const normalizedAddress = normalizeAddress(address);
	if (!normalizedAddress) {
		return null;
	}
	const match = TOP_PROTOCOL_INDEX[chain][normalizedAddress];
	if (!match) {
		return null;
	}
	return { ...match };
}

function buildProtocolAddressIndex(
	registry: readonly ProtocolEntry[],
): Record<Chain, Record<string, ProtocolEntry["match"]>> {
	const index: Record<Chain, Record<string, ProtocolEntry["match"]>> = {
		ethereum: {},
		base: {},
		arbitrum: {},
		optimism: {},
		polygon: {},
	};

	for (const entry of registry) {
		for (const chain of CHAIN_ORDER) {
			const chainRoots = entry.roots[chain];
			if (!chainRoots) {
				continue;
			}
			for (const rootAddress of chainRoots) {
				const normalized = normalizeAddress(rootAddress);
				if (!normalized) {
					continue;
				}
				index[chain][normalized] = entry.match;
			}
		}
	}

	return index;
}

function normalizeAddress(value: string): string | null {
	const normalized = value.trim().toLowerCase();
	if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
		return null;
	}
	return normalized;
}
