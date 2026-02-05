import { getChainConfig } from "../chains";
import { fetchWithTimeout } from "../http";
import type { Chain, EtherscanData } from "../types";
import type { ProviderRequestOptions } from "./request-options";

export async function getContractData(
	address: string,
	chain: Chain,
	apiKey?: string,
	options?: ProviderRequestOptions,
): Promise<EtherscanData | null> {
	if (!apiKey) {
		return null;
	}

	const chainConfig = getChainConfig(chain);
	const baseUrl = chainConfig.etherscanApiUrl;

	try {
		// Get source code (includes verification status and name)
		const sourceUrl = `${baseUrl}?module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
		const sourceRes = await fetchWithTimeout(
			sourceUrl,
			{ signal: options?.signal },
			options?.timeoutMs,
		);
		const sourceData = await sourceRes.json();

		if (sourceData.status !== "1" || !sourceData.result?.[0]) {
			return null;
		}

		const contractInfo = sourceData.result[0];
		const verified = contractInfo.SourceCode !== "";

		// Get transaction count
		const txCountUrl = `${baseUrl}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${apiKey}`;
		const txCountRes = await fetchWithTimeout(
			txCountUrl,
			{ signal: options?.signal },
			options?.timeoutMs,
		);
		const txCountData = await txCountRes.json();

		// Get creation info (first transaction is usually contract creation)
		let age_days: number | undefined;
		let creator: string | undefined;

		if (txCountData.status === "1" && txCountData.result?.length > 0) {
			const firstTx = txCountData.result[0];
			const creationTime = Number.parseInt(firstTx.timeStamp, 10) * 1000;
			age_days = Math.floor((Date.now() - creationTime) / (1000 * 60 * 60 * 24));
			creator = firstTx.from;
		}

		// Get total tx count
		const txListUrl = `${baseUrl}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=10000&apikey=${apiKey}`;
		const txListRes = await fetchWithTimeout(
			txListUrl,
			{ signal: options?.signal },
			options?.timeoutMs,
		);
		const txListData = await txListRes.json();
		const tx_count = txListData.status === "1" ? txListData.result?.length : undefined;

		return {
			verified,
			name: contractInfo.ContractName || undefined,
			source: verified ? contractInfo.SourceCode : undefined,
			age_days,
			tx_count,
			creator,
		};
	} catch {
		return null;
	}
}

export interface AddressLabels {
	nametag?: string;
	labels: string[];
}

export async function getAddressLabels(
	address: string,
	chain: Chain,
	apiKey?: string,
	options?: ProviderRequestOptions,
): Promise<AddressLabels | null> {
	const chainConfig = getChainConfig(chain);
	const baseUrl = chainConfig.etherscanApiUrl;
	const rootUrl = baseUrl.endsWith("/api") ? baseUrl.slice(0, -4) : baseUrl;
	const chainId = chainConfig.chainId;
	const apiKeyParam = apiKey ? `&apikey=${apiKey}` : "";
	const url = `${rootUrl}/api/v2/nametag?address=${address}&chainid=${chainId}${apiKeyParam}`;

	try {
		const response = await fetchWithTimeout(url, { signal: options?.signal }, options?.timeoutMs);
		if (!response.ok) {
			return await getPhishHackLabel(address, chainId, options);
		}

		const data = await response.json();
		const parsed = parseAddressLabels(data);
		if (parsed) return parsed;
		return await getPhishHackLabel(address, chainId, options);
	} catch {
		return await getPhishHackLabel(address, chainId, options);
	}
}

function parseAddressLabels(value: unknown): AddressLabels | null {
	if (!isRecord(value)) return null;

	if ("status" in value) {
		const status = value.status;
		if (status !== "1" && status !== 1) {
			return null;
		}
	}

	if (isRecord(value) && ("nametag" in value || "labels" in value)) {
		const parsed = parseNametagRecord(value);
		if (parsed) return parsed;
	}

	if (Array.isArray(value.result) && value.result.length > 0) {
		const entry = value.result[0];
		if (isRecord(entry)) {
			return parseNametagRecord(entry);
		}
	}

	return null;
}

function parseNametagRecord(record: Record<string, unknown>): AddressLabels | null {
	const nametag = isNonEmptyString(record.nametag) ? record.nametag : undefined;
	const labels = normalizeLabels(record.labels);
	if (!nametag && labels.length === 0) {
		return null;
	}
	return { nametag, labels };
}

function normalizeLabels(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter(isNonEmptyString);
	}
	if (isNonEmptyString(value)) {
		return [value];
	}
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

const PHISH_HACK_LABEL = "Phish / Hack";
const phishHackCache = new Map<number, Promise<Set<string> | null> | Set<string>>();

async function getPhishHackLabel(
	address: string,
	chainId: number,
	options?: ProviderRequestOptions,
): Promise<AddressLabels | null> {
	const set = await getPhishHackAddresses(chainId, options);
	if (!set) return null;
	if (!set.has(address.toLowerCase())) return null;
	return { labels: [PHISH_HACK_LABEL] };
}

async function getPhishHackAddresses(
	chainId: number,
	options?: ProviderRequestOptions,
): Promise<Set<string> | null> {
	const cached = phishHackCache.get(chainId);
	if (cached instanceof Set) return cached;
	if (cached) return cached;

	const fetchPromise = fetchPhishHackAddresses(chainId, options);
	phishHackCache.set(chainId, fetchPromise);
	const resolved = await fetchPromise;
	if (!resolved) {
		phishHackCache.delete(chainId);
		return null;
	}
	phishHackCache.set(chainId, resolved);
	return resolved;
}

async function fetchPhishHackAddresses(
	chainId: number,
	options?: ProviderRequestOptions,
): Promise<Set<string> | null> {
	try {
		const exportUrl = `https://api-metadata.etherscan.io/v2/api?chainid=${chainId}&module=nametag&action=exportaddresstags&label=phish-hack&format=csv`;
		const exportResponse = await fetchWithTimeout(
			exportUrl,
			{ signal: options?.signal },
			options?.timeoutMs,
		);
		if (!exportResponse.ok) return null;
		const exportData = await exportResponse.json();
		const csvLink = parseExportLink(exportData);
		if (!csvLink) return null;

		const csvResponse = await fetchWithTimeout(
			csvLink,
			{ signal: options?.signal },
			options?.timeoutMs,
		);
		if (!csvResponse.ok) return null;
		const csv = await csvResponse.text();
		const addresses = new Set<string>();
		for (const line of csv.split(/\r?\n/)) {
			const address = parseCsvAddress(line);
			if (address) addresses.add(address);
		}
		return addresses;
	} catch {
		return null;
	}
}

function parseExportLink(value: unknown): string | null {
	if (!isRecord(value)) return null;
	const link = value.link;
	return isNonEmptyString(link) ? link : null;
}

function parseCsvAddress(line: string): string | null {
	const match = line.match(/^"?(0x[a-fA-F0-9]{40})"?/);
	if (!match) return null;
	return match[1].toLowerCase();
}
