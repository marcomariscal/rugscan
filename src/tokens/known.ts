export interface KnownTokenMetadata {
	symbol: string;
	decimals: number;
	displayDecimals?: number;
}

const KNOWN_TOKEN_METADATA: Record<string, KnownTokenMetadata> = {
	// Ethereum
	"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, displayDecimals: 2 },
	"0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6, displayDecimals: 2 },
	"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": {
		symbol: "WETH",
		decimals: 18,
		displayDecimals: 4,
	},
	// Base
	"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6, displayDecimals: 2 },
	// Arbitrum
	"0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": {
		symbol: "USDC.e",
		decimals: 6,
		displayDecimals: 2,
	},
	"0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6, displayDecimals: 2 },
};

export function getKnownTokenMetadata(address: string | undefined): KnownTokenMetadata | null {
	if (!address) return null;
	const metadata = KNOWN_TOKEN_METADATA[address.toLowerCase()];
	return metadata ?? null;
}
