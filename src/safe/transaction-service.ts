import { z } from "zod";
import type { Chain } from "../types";

const safeTxSchema = z
	.object({
		safe: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
		to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
		value: z.string(),
		data: z.string().nullable(),
		operation: z.number().int(),
	})
	.passthrough();

export interface SafeMultisigTransaction {
	safe: string;
	to: string;
	value: string;
	data: string | null;
	operation: number;
}

export interface SafeTxServiceClient {
	fetchMultisigTransaction(options: {
		safeTxHash: string;
		chain: Chain;
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<SafeMultisigTransaction>;
}

export function parseSafeMultisigTransaction(json: unknown): SafeMultisigTransaction {
	const parsed = safeTxSchema.safeParse(json);
	if (!parsed.success) {
		throw new Error("Invalid Safe Transaction Service response");
	}

	return {
		safe: parsed.data.safe,
		to: parsed.data.to,
		value: parsed.data.value,
		data: parsed.data.data,
		operation: parsed.data.operation,
	};
}

export function createSafeTxServiceClient(options?: {
	fetchFn?: typeof fetch;
}): SafeTxServiceClient {
	const fetchFn = options?.fetchFn ?? fetch;

	return {
		fetchMultisigTransaction: async ({ safeTxHash, chain, timeoutMs, signal }) => {
			const baseUrl = resolveSafeTxServiceBaseUrl(chain);
			const url = `${baseUrl}/multisig-transactions/${safeTxHash}/`;

			const res = await fetchWithTimeoutFn(
				fetchFn,
				url,
				{ method: "GET", signal, headers: { accept: "application/json" } },
				timeoutMs,
			);
			if (!res.ok) {
				const body = await safeReadText(res);
				throw new Error(
					`Safe Transaction Service error (${res.status} ${res.statusText}) for ${safeTxHash}${
						body ? `: ${body}` : ""
					}`,
				);
			}

			const json = await safeReadJson(res);
			return parseSafeMultisigTransaction(json);
		},
	};
}

function resolveSafeTxServiceBaseUrl(chain: Chain): string {
	// Public Safe Transaction Service is now accessible via api.safe.global.
	// We only guarantee mainnet support for now.
	const slug = resolveTxServiceChainSlug(chain);
	return `https://api.safe.global/tx-service/${slug}/api/v1`;
}

function resolveTxServiceChainSlug(chain: Chain): string {
	if (chain === "ethereum") return "eth";
	if (chain === "base") return "base";
	if (chain === "arbitrum") return "arb1";
	if (chain === "optimism") return "oeth";
	if (chain === "polygon") return "matic";
	throw new Error(`Unsupported chain for Safe Transaction Service: ${chain}`);
}

async function fetchWithTimeoutFn(
	fetchFn: typeof fetch,
	input: RequestInfo | URL,
	init: RequestInit = {},
	timeoutMs: number | undefined,
): Promise<Response> {
	if (!timeoutMs) {
		return await fetchFn(input, init);
	}

	const controller = new AbortController();
	const parentSignal = init.signal;

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		if (parentSignal) {
			if (parentSignal.aborted) {
				controller.abort();
			} else {
				parentSignal.addEventListener(
					"abort",
					() => {
						controller.abort();
					},
					{ once: true },
				);
			}
		}

		timeoutId = setTimeout(() => {
			controller.abort();
		}, timeoutMs);

		return await fetchFn(input, { ...init, signal: controller.signal });
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}

async function safeReadJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

async function safeReadText(res: Response): Promise<string> {
	try {
		const text = await res.text();
		return text.trim();
	} catch {
		return "";
	}
}
