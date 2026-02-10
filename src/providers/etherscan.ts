import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getChainConfig } from "../chains";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "../http";
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
	labels: string[];
}

export async function getAddressLabels(
	address: string,
	chain: Chain,
	_apiKey?: string,
	options?: ProviderRequestOptions,
): Promise<AddressLabels | null> {
	// Scope update: Etherscan nametag/labels endpoint is Pro/Plus.
	// We only use Etherscan's phish/hack export list to preserve KNOWN_PHISHING.
	const chainId = getChainConfig(chain).chainId;
	return await getPhishHackLabel(address, chainId, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export type LabelsCacheState = "cold" | "warm" | "stale";

const PHISH_HACK_LABEL = "Phish / Hack";
const PHISH_HACK_CACHE_VERSION = 1;
const PHISH_HACK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const phishHackCache = new Map<number, Promise<Set<string> | null> | Set<string>>();

export function getLabelsCacheState(chain: Chain, nowMs: number = Date.now()): LabelsCacheState {
	const chainId = getChainConfig(chain).chainId;
	return getPhishHackDiskCacheState(chainId, nowMs);
}

/** Reset in-memory caches — only intended for tests. */
export function _resetPhishHackCache(): void {
	phishHackCache.clear();
}

function resolveAssayCacheDir(): string {
	const explicit = process.env.ASSAY_CACHE_DIR;
	if (explicit && explicit.trim().length > 0) return explicit;
	return path.join(os.homedir(), ".config", "assay", "cache");
}

function resolvePhishHackCachePath(chainId: number): string {
	return path.join(resolveAssayCacheDir(), `etherscan-phish-hack-${chainId}.json`);
}

function getPhishHackDiskCacheState(
	chainId: number,
	nowMs: number,
	ttlMs: number = PHISH_HACK_CACHE_TTL_MS,
): LabelsCacheState {
	const cachePath = resolvePhishHackCachePath(chainId);
	if (!existsSync(cachePath)) return "cold";
	try {
		const stat = statSync(cachePath);
		const ageMs = nowMs - stat.mtimeMs;
		return ageMs > ttlMs ? "stale" : "warm";
	} catch {
		return "cold";
	}
}

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
	// Respect timeboxed/no-cache modes (ex: wallet mode).
	if (options?.cache === false) {
		return await fetchPhishHackAddresses(chainId, options);
	}

	const cached = phishHackCache.get(chainId);
	if (cached instanceof Set) return cached;
	if (cached) return cached;

	const diskSet = await readPhishHackDiskCache(chainId);
	if (diskSet) {
		phishHackCache.set(chainId, diskSet);

		// Best-effort refresh when stale, but never block the caller on a slow export.
		if (getPhishHackDiskCacheState(chainId, Date.now()) === "stale") {
			const refreshTimeoutMs = resolveRefreshTimeoutMs(options?.timeoutMs);
			const refreshed = await fetchPhishHackAddresses(chainId, {
				...options,
				timeoutMs: refreshTimeoutMs,
			});
			if (refreshed) {
				phishHackCache.set(chainId, refreshed);
				await writePhishHackDiskCache(chainId, refreshed);
				return refreshed;
			}
		}

		return diskSet;
	}

	const fetchPromise = fetchPhishHackAddresses(chainId, options);
	phishHackCache.set(chainId, fetchPromise);
	const resolved = await fetchPromise;
	if (!resolved) {
		phishHackCache.delete(chainId);
		return null;
	}
	phishHackCache.set(chainId, resolved);
	await writePhishHackDiskCache(chainId, resolved);
	return resolved;
}

function resolveRefreshTimeoutMs(timeoutMs: number | undefined): number {
	const base = timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	return Math.max(500, Math.min(base, 2_000));
}

async function readPhishHackDiskCache(chainId: number): Promise<Set<string> | null> {
	const cachePath = resolvePhishHackCachePath(chainId);
	if (!existsSync(cachePath)) return null;

	try {
		const raw = await readFile(cachePath, "utf-8");
		const parsed = safeJsonParse(raw);
		const addresses = parsePhishHackCacheAddresses(parsed);
		if (!addresses || addresses.length === 0) return null;
		return new Set(addresses);
	} catch {
		return null;
	}
}

async function writePhishHackDiskCache(chainId: number, addresses: Set<string>): Promise<void> {
	const cachePath = resolvePhishHackCachePath(chainId);
	try {
		await mkdir(path.dirname(cachePath), { recursive: true });
		const payload = {
			version: PHISH_HACK_CACHE_VERSION,
			updatedAtMs: Date.now(),
			addresses: [...addresses],
		};
		await writeFile(cachePath, `${JSON.stringify(payload)}\n`, "utf-8");
	} catch {
		// Best-effort cache: failures should never break label lookup.
	}
}

function safeJsonParse(raw: string): unknown | null {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function parsePhishHackCacheAddresses(value: unknown): string[] | null {
	if (!isRecord(value)) return null;
	if (value.version !== PHISH_HACK_CACHE_VERSION) return null;
	if (!Array.isArray(value.addresses)) return null;

	const addresses: string[] = [];
	for (const entry of value.addresses) {
		if (typeof entry !== "string") continue;
		const normalized = parseCsvAddress(entry);
		if (normalized) addresses.push(normalized);
	}
	return addresses;
}

async function fetchPhishHackAddresses(
	chainId: number,
	options?: ProviderRequestOptions,
): Promise<Set<string> | null> {
	try {
		const totalTimeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
		const perRequestTimeoutMs = Math.max(1_000, Math.floor(totalTimeoutMs / 2));

		const exportUrl = `https://api-metadata.etherscan.io/v2/api?chainid=${chainId}&module=nametag&action=exportaddresstags&label=phish-hack&format=csv`;
		const exportResponse = await fetchWithTimeout(
			exportUrl,
			{ signal: options?.signal },
			perRequestTimeoutMs,
		);
		if (!exportResponse.ok) return null;
		const exportData = await exportResponse.json();
		const csvLink = parseExportLink(exportData);
		if (!csvLink) return null;

		const csvResponse = await fetchWithTimeout(
			csvLink,
			{ signal: options?.signal },
			perRequestTimeoutMs,
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
