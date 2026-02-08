import type { Chain } from "../types";
import { decodeMultiSendCalldata } from "./multisend";
import type { SafeMultisigTransaction } from "./transaction-service";

export interface SafeCall {
	to: string;
	value: string;
	data: string;
	operation: number;
	from?: string;
	chainId?: string;
}

export type SafeIngestPlan =
	| {
			kind: "single";
			safe: string;
			topLevel: SafeCall;
			callsToAnalyze: SafeCall[];
	  }
	| {
			kind: "multisend";
			safe: string;
			topLevel: SafeCall;
			callsToAnalyze: SafeCall[];
			truncated: boolean;
	  }
	| {
			kind: "multisendTooLarge";
			safe: string;
			topLevel: SafeCall;
			callsToAnalyze: SafeCall[];
			targets: string[];
			truncated: boolean;
	  };

export function buildSafeIngestPlan(options: {
	tx: SafeMultisigTransaction;
	chain: Chain;
}): SafeIngestPlan {
	const chainId = chainToChainId(options.chain);
	const data = options.tx.data ?? "0x";

	const topLevel: SafeCall = {
		to: options.tx.to.toLowerCase(),
		value: options.tx.value,
		data,
		operation: options.tx.operation,
		from: options.tx.safe.toLowerCase(),
		chainId,
	};

	const multi = decodeMultiSendCalldata(data);
	if (multi.kind === "decoded") {
		const sender = resolveMultiSendSender({
			safe: options.tx.safe,
			multisend: options.tx.to,
			safeOperation: options.tx.operation,
		});

		const calls: SafeCall[] = multi.calls.map((call) => ({
			to: call.to.toLowerCase(),
			value: call.value,
			data: call.data,
			operation: call.operation,
			from: sender,
			chainId,
		}));
		return {
			kind: "multisend",
			safe: options.tx.safe.toLowerCase(),
			topLevel,
			callsToAnalyze: calls,
			truncated: multi.truncated,
		};
	}

	if (multi.kind === "tooLarge") {
		return {
			kind: "multisendTooLarge",
			safe: options.tx.safe.toLowerCase(),
			topLevel,
			callsToAnalyze: [topLevel],
			targets: multi.targets,
			truncated: multi.truncated,
		};
	}

	return {
		kind: "single",
		safe: options.tx.safe.toLowerCase(),
		topLevel,
		callsToAnalyze: [topLevel],
	};
}

function resolveMultiSendSender(options: {
	safe: string;
	multisend: string;
	safeOperation: number;
}): string {
	// For the canonical Safe MultiSend flow, the Safe performs a DELEGATECALL
	// into the MultiSend contract, meaning sub-calls appear with msg.sender = Safe.
	if (options.safeOperation === 1) return options.safe.toLowerCase();
	return options.multisend.toLowerCase();
}

function chainToChainId(chain: Chain): string {
	if (chain === "ethereum") return "1";
	if (chain === "base") return "8453";
	if (chain === "arbitrum") return "42161";
	if (chain === "optimism") return "10";
	if (chain === "polygon") return "137";
	return "1";
}
