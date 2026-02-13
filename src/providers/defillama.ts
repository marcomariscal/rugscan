import { fetchWithTimeout } from "../http";
import { matchTopProtocolAddress } from "../protocols/top-protocol-registry";
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

interface Protocol {
	name: string;
	slug: string;
	tvl: number;
	chains: string[];
	address?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProtocols(value: unknown): Protocol[] {
	if (!Array.isArray(value)) return [];
	const result: Protocol[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const name = entry.name;
		const slug = entry.slug;
		const tvl = entry.tvl;
		const chains = entry.chains;
		const address = entry.address;
		if (typeof name !== "string" || typeof slug !== "string") continue;
		if (typeof tvl !== "number") continue;
		if (!Array.isArray(chains)) continue;
		const chainNames = chains.filter((chain): chain is string => typeof chain === "string");
		if (address !== undefined && typeof address !== "string") continue;
		result.push({ name, slug, tvl, chains: chainNames, address });
	}
	return result;
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

		const protocols = parseProtocols(await response.json());
		protocolCache = protocols;
		cacheTime = now;
		return protocols;
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
	const manualMatch = matchTopProtocolAddress(normalizedAddress, chain);
	if (manualMatch) {
		// Avoid network dependency for known addresses.
		return manualMatch;
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
