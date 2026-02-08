import type { Chain } from "../types";
import { createSafeTxServiceClient, parseSafeMultisigTransaction } from "./transaction-service";

export async function loadSafeMultisigTransaction(options: {
	chain: Chain;
	safeTxHash: string;
	offline: boolean;
	safeTxJsonPath?: string;
	fetchFn?: typeof fetch;
}): Promise<ReturnType<typeof parseSafeMultisigTransaction>> {
	if (options.offline && !options.safeTxJsonPath) {
		throw new Error("offline mode: provide --safe-tx-json (no Safe API fetch)");
	}

	if (options.safeTxJsonPath) {
		const json = await readJsonFile(options.safeTxJsonPath);
		return parseSafeMultisigTransaction(json);
	}

	const client = createSafeTxServiceClient({ fetchFn: options.fetchFn });
	return await client.fetchMultisigTransaction({
		safeTxHash: options.safeTxHash,
		chain: options.chain,
		timeoutMs: 10_000,
	});
}

async function readJsonFile(path: string): Promise<unknown> {
	try {
		const text = await Bun.file(path).text();
		return JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown error";
		throw new Error(`Failed to read JSON file: ${message}`);
	}
}
