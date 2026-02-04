import { setTimeout as delay } from "node:timers/promises";
import { fetchWithTimeout } from "../http";
import type { Chain, ProviderResult, TokenSecurity } from "../types";

const GOPLUS_API = "https://api.gopluslabs.io/api/v1";

const tokenSecurityCache = new Map<string, Promise<ProviderResult<TokenSecurity>>>();

// Chain ID mapping for GoPlus
const CHAIN_IDS: Record<Chain, string> = {
	ethereum: "1",
	base: "8453",
	arbitrum: "42161",
	optimism: "10",
	polygon: "137",
};

interface GoPlusResponse {
	code: number;
	message: string;
	result: Record<string, GoPlusTokenData>;
}

interface GoPlusTokenData {
	is_honeypot?: string;
	is_mintable?: string;
	can_take_back_ownership?: string;
	hidden_owner?: string;
	selfdestruct?: string;
	buy_tax?: string;
	sell_tax?: string;
	is_blacklisted?: string;
	owner_change_balance?: string;
	is_open_source?: string;
	is_proxy?: string;
}

function toBool(val: string | undefined): boolean | undefined {
	if (val === undefined) return undefined;
	return val === "1";
}

function toNumber(val: string | undefined): number | undefined {
	if (!val) return undefined;
	const n = Number.parseFloat(val);
	return Number.isNaN(n) ? undefined : n;
}

export async function getTokenSecurity(
	address: string,
	chain: Chain,
): Promise<ProviderResult<TokenSecurity>> {
	const normalized = address.toLowerCase();
	const cacheKey = `${chain}:${normalized}`;
	const cached = tokenSecurityCache.get(cacheKey);
	if (cached) return await cached;

	const promise = fetchTokenSecurity(normalized, chain);
	tokenSecurityCache.set(cacheKey, promise);
	return await promise;
}

async function fetchTokenSecurity(
	normalizedAddress: string,
	chain: Chain,
): Promise<ProviderResult<TokenSecurity>> {
	const chainId = CHAIN_IDS[chain];

	const url = `${GOPLUS_API}/token_security/${chainId}?contract_addresses=${normalizedAddress}`;
	const attempts = 3;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const response = await fetchWithTimeout(url);
			if (!response.ok) {
				const retryable = response.status === 429 || response.status >= 500;
				if (retryable && attempt < attempts - 1) {
					await delay(250 * (attempt + 1));
					continue;
				}
				return { data: null, error: `goplus http ${response.status}` };
			}

			const data: GoPlusResponse = await response.json();
			if (data.code !== 1 || !data.result) {
				return { data: null, error: data.message || "goplus response error" };
			}

			const tokenData = data.result[normalizedAddress];
			if (!tokenData) {
				return { data: null };
			}

			return {
				data: {
					is_honeypot: toBool(tokenData.is_honeypot),
					is_mintable: toBool(tokenData.is_mintable),
					can_take_back_ownership: toBool(tokenData.can_take_back_ownership),
					hidden_owner: toBool(tokenData.hidden_owner),
					selfdestruct: toBool(tokenData.selfdestruct),
					buy_tax: toNumber(tokenData.buy_tax),
					sell_tax: toNumber(tokenData.sell_tax),
					is_blacklisted: toBool(tokenData.is_blacklisted),
					owner_can_change_balance: toBool(tokenData.owner_change_balance),
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : "goplus request failed";
			if (attempt < attempts - 1) {
				await delay(250 * (attempt + 1));
				continue;
			}
			return { data: null, error: message };
		}
	}

	return { data: null, error: "goplus request failed" };
}

export async function isToken(address: string, chain: Chain): Promise<boolean> {
	// Quick check if GoPlus has data for this address (indicates it's a token)
	const security = await getTokenSecurity(address, chain);
	return security.data !== null;
}
