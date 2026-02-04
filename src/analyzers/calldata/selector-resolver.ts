import { fetchWithTimeout } from "../../http";
import { isRecord } from "./utils";

const FOURBYTE_API = "https://www.4byte.directory/api/v1/signatures/";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

interface CachedSelector {
	signatures: string[];
	fetchedAt: number;
}

export interface SelectorLookupResult {
	selector: string;
	signatures: string[];
	cached: boolean;
}

const selectorCache = new Map<string, CachedSelector>();

export async function resolveSelector(selector: string): Promise<SelectorLookupResult> {
	const normalized = selector.toLowerCase();
	const now = Date.now();
	const cached = selectorCache.get(normalized);
	if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
		return { selector: normalized, signatures: cached.signatures, cached: true };
	}

	try {
		const response = await fetchWithTimeout(`${FOURBYTE_API}?hex_signature=${normalized}`);
		if (!response.ok) {
			return cachedResult(normalized, cached);
		}
		const payload: unknown = await response.json();
		const signatures = extractSignatures(payload);
		selectorCache.set(normalized, { signatures, fetchedAt: now });
		return { selector: normalized, signatures, cached: false };
	} catch {
		return cachedResult(normalized, cached);
	}
}

export function clearSelectorCache(): void {
	selectorCache.clear();
}

function cachedResult(selector: string, cached?: CachedSelector): SelectorLookupResult {
	return {
		selector,
		signatures: cached?.signatures ?? [],
		cached: Boolean(cached),
	};
}

function extractSignatures(payload: unknown): string[] {
	if (!isRecord(payload)) return [];
	const results = payload.results;
	if (!Array.isArray(results)) return [];
	const signatures: string[] = [];
	for (const entry of results) {
		if (!isRecord(entry)) continue;
		const signature = entry.text_signature;
		if (typeof signature === "string") {
			signatures.push(signature);
		}
	}
	return dedupeStrings(signatures);
}

function dedupeStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		deduped.push(value);
	}
	return deduped;
}
