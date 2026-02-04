import type { Chain } from "./types";

export interface ChainConfig {
	chainId: number;
	name: string;
	rpcUrl: string;
	etherscanApiUrl: string;
	etherscanUrl: string;
	sourcifyChainId: number;
}

export const CHAINS: Record<Chain, ChainConfig> = {
	ethereum: {
		chainId: 1,
		name: "Ethereum",
		rpcUrl: "https://ethereum.publicnode.com", // default mainnet RPC (used for fork URL + eth_call/logs)
		etherscanApiUrl: "https://api.etherscan.io/api",
		etherscanUrl: "https://etherscan.io",
		sourcifyChainId: 1,
	},
	base: {
		chainId: 8453,
		name: "Base",
		rpcUrl: "https://base.drpc.org",
		etherscanApiUrl: "https://api.basescan.org/api",
		etherscanUrl: "https://basescan.org",
		sourcifyChainId: 8453,
	},
	arbitrum: {
		chainId: 42161,
		name: "Arbitrum",
		rpcUrl: "https://arbitrum.llamarpc.com",
		etherscanApiUrl: "https://api.arbiscan.io/api",
		etherscanUrl: "https://arbiscan.io",
		sourcifyChainId: 42161,
	},
	optimism: {
		chainId: 10,
		name: "Optimism",
		rpcUrl: "https://optimism.llamarpc.com",
		etherscanApiUrl: "https://api-optimistic.etherscan.io/api",
		etherscanUrl: "https://optimistic.etherscan.io",
		sourcifyChainId: 10,
	},
	polygon: {
		chainId: 137,
		name: "Polygon",
		rpcUrl: "https://polygon.llamarpc.com",
		etherscanApiUrl: "https://api.polygonscan.com/api",
		etherscanUrl: "https://polygonscan.com",
		sourcifyChainId: 137,
	},
};

export function getChainConfig(chain: Chain): ChainConfig {
	return CHAINS[chain];
}
