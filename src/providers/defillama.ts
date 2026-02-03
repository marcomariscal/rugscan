import type { Chain, ProtocolMatch } from "../types";

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
		// Aave V3 Pool
		"0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": { name: "Aave V3", slug: "aave-v3" },
		// Uniswap V3 SwapRouter02
		"0xe592427a0aece92de3edee1f18e0157c05861564": { name: "Uniswap V3", slug: "uniswap-v3" },
		// Curve 3pool
		"0xbebc44782c7db0a1a60cb6fe97d0e3d5c3c9f0fe": { name: "Curve DEX", slug: "curve-dex" },
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

async function getProtocols(): Promise<Protocol[]> {
	const now = Date.now();
	if (protocolCache && now - cacheTime < CACHE_TTL) {
		return protocolCache;
	}

	try {
		const response = await fetch(`${DEFILLAMA_API}/protocols`);
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

export async function matchProtocol(address: string, chain: Chain): Promise<ProtocolMatch | null> {
	const protocols = await getProtocols();
	const chainName = CHAIN_NAMES[chain];
	const normalizedAddress = address.toLowerCase();
	const manualMatch = KNOWN_PROTOCOL_ADDRESSES[chain]?.[normalizedAddress];
	if (manualMatch) {
		return resolveManualMatch(protocols, manualMatch);
	}

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

function resolveManualMatch(protocols: Protocol[], match: ProtocolOverride): ProtocolMatch {
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
