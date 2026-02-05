import type { Abi } from "viem";
import { getChainConfig } from "../chains";
import { fetchWithTimeout } from "../http";
import type { Chain, VerificationResult } from "../types";
import type { ProviderRequestOptions } from "./request-options";

const SOURCIFY_API = "https://sourcify.dev/server";
const SOURCIFY_CACHE = new Map<string, Promise<SourcifyResult> | SourcifyResult>();

interface SourcifyFile {
	name: string;
	path: string;
	content: string;
}

interface SourcifyAnyResponse {
	status: "full" | "partial";
	files: SourcifyFile[];
}

interface SourcifyResult extends VerificationResult {
	abi?: Abi;
}

export async function checkVerification(
	address: string,
	chain: Chain,
	options?: ProviderRequestOptions,
): Promise<VerificationResult> {
	const result = await getSourcifyResult(address, chain, options);
	return {
		verified: result.verified,
		name: result.name,
		source: result.source,
		abi: result.abi,
	};
}

export async function getABI(
	address: string,
	chain: Chain,
	options?: ProviderRequestOptions,
): Promise<Abi | null> {
	const result = await getSourcifyResult(address, chain, options);
	if (!result.verified || !result.abi) return null;
	return result.abi;
}

async function getSourcifyResult(
	address: string,
	chain: Chain,
	options?: ProviderRequestOptions,
): Promise<SourcifyResult> {
	const chainId = getChainConfig(chain).sourcifyChainId;

	if (options?.cache === false) {
		return await fetchSourcifyResult(address, chainId, options);
	}

	const key = `${chainId}:${address.toLowerCase()}`;
	const cached = SOURCIFY_CACHE.get(key);
	if (cached) {
		if (cached instanceof Promise) {
			return cached;
		}
		return cached;
	}
	const fetchPromise = fetchSourcifyResult(address, chainId, options);
	SOURCIFY_CACHE.set(key, fetchPromise);
	try {
		const resolved = await fetchPromise;
		SOURCIFY_CACHE.set(key, resolved);
		return resolved;
	} catch (error) {
		// Don't poison the cache with transient failures.
		SOURCIFY_CACHE.delete(key);
		throw error;
	}
}

async function fetchSourcifyResult(
	address: string,
	chainId: number,
	options?: ProviderRequestOptions,
): Promise<SourcifyResult> {
	const url = `${SOURCIFY_API}/files/any/${chainId}/${address}`;

	try {
		const response = await fetchWithTimeout(url, { signal: options?.signal }, options?.timeoutMs);

		if (!response.ok) {
			// 404 means the contract is not verified on Sourcify.
			if (response.status === 404) {
				return { verified: false };
			}
			// For timeboxed/analyzer calls, treat non-404 failures as "unknown" by throwing.
			if (options?.signal || options?.timeoutMs) {
				throw new Error(`sourcify http ${response.status}`);
			}
			return { verified: false };
		}

		const data: SourcifyAnyResponse = await response.json();
		const files = data.files;

		if (!files || files.length === 0) {
			return { verified: false };
		}

		const metadata = files.find((f) => f.name === "metadata.json");
		const parsedMetadata = metadata ? parseMetadata(metadata.content) : undefined;

		const sourceFile = files.find(
			(f) => f.name.endsWith(".sol") && !f.path.includes("node_modules"),
		);

		return {
			verified: true,
			name: parsedMetadata?.name,
			source: sourceFile?.content,
			abi: parsedMetadata?.abi,
		};
	} catch (error) {
		// When the analyzer passes request options, treat network/timeout errors as unknown.
		// This prevents transient failures from being interpreted as an "unverified" contract.
		if (options?.signal || options?.timeoutMs) {
			throw error;
		}
		return { verified: false };
	}
}

function parseMetadata(content: string): { name?: string; abi?: Abi } | undefined {
	try {
		const parsed = JSON.parse(content);
		const name = extractContractName(parsed);
		const abi = extractAbi(parsed);
		return { name, abi };
	} catch {
		return undefined;
	}
}

function extractContractName(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const output = value.output;
	if (isRecord(output)) {
		const devdoc = output.devdoc;
		if (isRecord(devdoc)) {
			const title = devdoc.title;
			if (isNonEmptyString(title)) {
				return title;
			}
		}
	}
	const settings = value.settings;
	if (isRecord(settings)) {
		const compilationTarget = settings.compilationTarget;
		const targetName = extractCompilationTarget(compilationTarget);
		if (targetName) return targetName;
	}
	return undefined;
}

function extractCompilationTarget(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	for (const entry of Object.values(value)) {
		if (isNonEmptyString(entry)) return entry;
	}
	return undefined;
}

function extractAbi(value: unknown): Abi | undefined {
	if (!isRecord(value)) return undefined;
	const output = value.output;
	if (!isRecord(output)) return undefined;
	const abi = output.abi;
	if (isAbi(abi)) return abi;
	return undefined;
}

function isAbi(value: unknown): value is Abi {
	if (!Array.isArray(value)) return false;
	return value.every(isAbiItem);
}

function isAbiItem(value: unknown): value is { type: string } {
	return isRecord(value) && typeof value.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
