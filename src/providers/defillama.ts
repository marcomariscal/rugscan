import { fetchWithTimeout } from "../http";
import type { Chain, ProtocolMatch } from "../types";
import type { ProviderRequestOptions } from "./request-options";

const DEFILLAMA_API = "https://api.llama.fi";

// Chain name mapping for DeFiLlama
const CHAIN_NAMES: Record<Chain, string> = {
	ethereum: "ethereum",
	base: "base",
	arbitrum: "arbitrum",
	optimism: "optimism",
	polygon: "polygon",
};

interface ProtocolOverride {
	name: string;
	slug: string;
}

const KNOWN_PROTOCOL_ADDRESSES: Partial<Record<Chain, Record<string, ProtocolOverride>>> = {
	ethereum: {
		// Uniswap
		"0x7a250d5630b4cf539739df2c5dacb4c659f2488d": { name: "Uniswap V2", slug: "uniswap-v2" },
		"0xe592427a0aece92de3edee1f18e0157c05861564": { name: "Uniswap V3", slug: "uniswap-v3" },
		"0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": { name: "Uniswap V3", slug: "uniswap-v3" },
		"0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": { name: "Uniswap", slug: "uniswap" },
		"0x66a9893cc07d91d95644aedd05d03f95e1dba8af": { name: "Uniswap", slug: "uniswap" },
		// Aave
		"0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": { name: "Aave V3", slug: "aave-v3" },
		"0xd322a49006fc828f9b5b37ab215f99b4e5cab19c": { name: "Aave V3", slug: "aave-v3" },
		"0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9": { name: "Aave V2", slug: "aave-v2" },
		// Curve
		"0xbebc44782c7db0a1a60cb6fe97d0e3d5c3c9f0fe": { name: "Curve DEX", slug: "curve-dex" },
		"0x99a58482bd75cbab83b27ec03ca68ff489b5788f": { name: "Curve DEX", slug: "curve-dex" },
		// 1inch
		"0x1111111254eeb25477b68fb85ed929f73a960582": { name: "1inch", slug: "1inch-network" },
		// WETH
		"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { name: "WETH", slug: "weth" },
		// USDC/Circle
		"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { name: "Circle USDC", slug: "circle" },
		// USDT/Tether
		"0xdac17f958d2ee523a2206206994597c13d831ec7": { name: "Tether USDT", slug: "tether" },
		// Lido
		"0xae7ab96520de3a18e5e111b5eaab095312d7fe84": { name: "Lido", slug: "lido" },
		// Compound
		"0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b": { name: "Compound", slug: "compound-finance" },
	},
};

interface Protocol {
	name: string;
	slug: string;
	tvl: number;
	chains: string[];
	address?: string;
}

let protocolCache: Protocol[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

async function getProtocols(options?: ProviderRequestOptions): Promise<Protocol[]> {
	const now = Date.now();
	if (protocolCache && now - cacheTime < CACHE_TTL) {
		return protocolCache;
	}

	try {
		const response = await fetchWithTimeout(
			`${DEFILLAMA_API}/protocols`,
			{ signal: options?.signal },
			options?.timeoutMs,
		);
		if (!response.ok) {
			return protocolCache || [];
		}

		protocolCache = await response.json();
		cacheTime = now;
		return protocolCache;
	} catch {
		return protocolCache || [];
	}
}

export interface DeFiLlamaMatchOptions extends ProviderRequestOptions {
	/**
	 * When false, skips the /protocols lookup entirely (manual matches only).
	 */
	allowNetwork?: boolean;
}

export async function matchProtocol(
	address: string,
	chain: Chain,
	options?: DeFiLlamaMatchOptions,
): Promise<ProtocolMatch | null> {
	const chainName = CHAIN_NAMES[chain];
	const normalizedAddress = address.toLowerCase();
	const manualMatch = KNOWN_PROTOCOL_ADDRESSES[chain]?.[normalizedAddress];
	if (manualMatch) {
		// Avoid network dependency for known addresses.
		return { name: manualMatch.name, slug: manualMatch.slug };
	}

	if (options?.allowNetwork === false) {
		return null;
	}

	const protocols = await getProtocols(options);

	// DeFiLlama doesn't have direct address mapping for most protocols
	// This is a best-effort match based on known addresses
	// In practice, you'd need a separate address->protocol mapping

	for (const protocol of protocols) {
		// Check if protocol operates on this chain
		const protocolChains = protocol.chains?.map((chainEntry) => chainEntry.toLowerCase());
		if (!protocolChains?.includes(chainName)) {
			continue;
		}

		const addressMatches = getProtocolAddresses(protocol.address)
			.map((rawAddress) => parseProtocolAddress(rawAddress))
			.filter((entry): entry is ParsedAddress => entry !== null)
			.some((entry) => matchesProtocolAddress(entry, chain, normalizedAddress));
		if (addressMatches) {
			return { name: protocol.name, tvl: protocol.tvl, slug: protocol.slug };
		}
	}

	return null;
}

interface ParsedAddress {
	chain: Chain | null;
	address: string;
}

function _resolveManualMatch(protocols: Protocol[], match: ProtocolOverride): ProtocolMatch {
	for (const protocol of protocols) {
		if (protocol.slug === match.slug) {
			return { name: protocol.name, tvl: protocol.tvl, slug: protocol.slug };
		}
	}
	return { name: match.name, slug: match.slug };
}

function getProtocolAddresses(raw: unknown): string[] {
	if (typeof raw === "string") {
		return expandAddressList(raw);
	}
	if (Array.isArray(raw)) {
		const values: string[] = [];
		for (const entry of raw) {
			if (typeof entry === "string") {
				values.push(...expandAddressList(entry));
			}
		}
		return values;
	}
	return [];
}

function expandAddressList(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function parseProtocolAddress(value: string): ParsedAddress | null {
	const normalized = value.trim().toLowerCase();
	if (!normalized) return null;
	const separatorIndex = normalized.indexOf(":");
	if (separatorIndex === -1) {
		return isHexAddress(normalized) ? { chain: null, address: normalized } : null;
	}
	const prefix = normalized.slice(0, separatorIndex);
	const address = normalized.slice(separatorIndex + 1);
	if (!isHexAddress(address)) return null;
	const chain = resolveChainPrefix(prefix);
	if (!chain) return null;
	return { chain, address };
}

function resolveChainPrefix(prefix: string): Chain | null {
	if (prefix === "ethereum" || prefix === "eth") return "ethereum";
	if (prefix === "arbitrum" || prefix === "arb") return "arbitrum";
	if (prefix === "optimism" || prefix === "op") return "optimism";
	if (prefix === "base") return "base";
	if (prefix === "polygon" || prefix === "matic" || prefix === "polygon-pos") return "polygon";
	return null;
}

function matchesProtocolAddress(
	entry: ParsedAddress,
	chain: Chain,
	normalizedAddress: string,
): boolean {
	if (entry.address !== normalizedAddress) return false;
	if (entry.chain) return entry.chain === chain;
	return chain === "ethereum";
}

function isHexAddress(value: string): boolean {
	return /^0x[a-f0-9]{40}$/.test(value);
}
