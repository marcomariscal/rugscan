import type { Hex } from "viem";
import { bytesToHex, decodeFunctionData, hexToBytes, isHex } from "viem";

export interface MultiSendCall {
	operation: number;
	to: string;
	value: string;
	data: Hex;
}

const MULTISEND_ABI = [
	{
		type: "function",
		name: "multiSend",
		stateMutability: "nonpayable",
		inputs: [{ name: "transactions", type: "bytes" }],
		outputs: [],
	},
] as const;

const MAX_DECODE_BYTES = 2_000_000;
const MAX_CALLS = 250;

export type MultiSendDecodeResult =
	| { kind: "notMultisend" }
	| { kind: "decoded"; calls: MultiSendCall[]; truncated: boolean }
	| { kind: "tooLarge"; message: string; targets: string[]; truncated: boolean }
	| { kind: "error"; message: string };

export function decodeMultiSendCalldata(data: string): MultiSendDecodeResult {
	if (!isHex(data)) return { kind: "notMultisend" };

	let transactionsHex: Hex;
	try {
		const decoded = decodeFunctionData({ abi: MULTISEND_ABI, data });
		if (decoded.functionName !== "multiSend") {
			return { kind: "notMultisend" };
		}
		const arg = decoded.args[0];
		if (!isHex(arg)) {
			return { kind: "error", message: "Invalid multiSend transactions argument" };
		}
		transactionsHex = arg;
	} catch {
		return { kind: "notMultisend" };
	}

	const rawBytes = hexToBytes(transactionsHex);
	if (rawBytes.length > MAX_DECODE_BYTES) {
		const targets = extractTargetsFromMultiSendBytes(rawBytes, { maxCalls: MAX_CALLS });
		return {
			kind: "tooLarge",
			message: `multiSend batch too large to fully decode (${rawBytes.length} bytes)`,
			targets: targets.targets,
			truncated: targets.truncated,
		};
	}

	try {
		const parsed = decodeMultiSendBytes(rawBytes, { maxCalls: MAX_CALLS });
		if (parsed.kind === "error") return parsed;
		return { kind: "decoded", calls: parsed.calls, truncated: parsed.truncated };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to decode multiSend";
		return { kind: "error", message };
	}
}

function decodeMultiSendBytes(
	bytes: Uint8Array,
	options: { maxCalls: number },
):
	| { kind: "decoded"; calls: MultiSendCall[]; truncated: boolean }
	| { kind: "error"; message: string } {
	const calls: MultiSendCall[] = [];
	let offset = 0;
	let truncated = false;

	while (offset < bytes.length) {
		if (calls.length >= options.maxCalls) {
			truncated = true;
			break;
		}
		const headerSize = 1 + 20 + 32 + 32;
		if (offset + headerSize > bytes.length) {
			return { kind: "error", message: "Invalid multiSend batch: truncated header" };
		}
		const operation = bytes[offset];
		offset += 1;

		const toBytes = bytes.slice(offset, offset + 20);
		offset += 20;
		const to = normalizeAddress(bytesToHex(toBytes));

		const valueBytes = bytes.slice(offset, offset + 32);
		offset += 32;
		const value = bytesToBigInt(valueBytes).toString();

		const dataLenBytes = bytes.slice(offset, offset + 32);
		offset += 32;
		const dataLenBig = bytesToBigInt(dataLenBytes);
		if (dataLenBig > BigInt(Number.MAX_SAFE_INTEGER)) {
			return { kind: "error", message: "Invalid multiSend batch: data length too large" };
		}
		const dataLen = Number(dataLenBig);
		if (offset + dataLen > bytes.length) {
			return { kind: "error", message: "Invalid multiSend batch: truncated calldata" };
		}
		const dataBytes = bytes.slice(offset, offset + dataLen);
		offset += dataLen;

		calls.push({
			operation,
			to,
			value,
			data: bytesToHex(dataBytes),
		});
	}

	return { kind: "decoded", calls, truncated };
}

function extractTargetsFromMultiSendBytes(
	bytes: Uint8Array,
	options: { maxCalls: number },
): { targets: string[]; truncated: boolean } {
	const targets: string[] = [];
	let offset = 0;
	let truncated = false;

	while (offset < bytes.length) {
		if (targets.length >= options.maxCalls) {
			truncated = true;
			break;
		}
		const headerSize = 1 + 20 + 32 + 32;
		if (offset + headerSize > bytes.length) {
			truncated = true;
			break;
		}
		// operation
		offset += 1;
		// to
		const toBytes = bytes.slice(offset, offset + 20);
		offset += 20;
		targets.push(normalizeAddress(bytesToHex(toBytes)));
		// value
		offset += 32;
		// dataLen
		const dataLenBytes = bytes.slice(offset, offset + 32);
		offset += 32;
		const dataLenBig = bytesToBigInt(dataLenBytes);
		if (dataLenBig > BigInt(Number.MAX_SAFE_INTEGER)) {
			truncated = true;
			break;
		}
		const dataLen = Number(dataLenBig);
		if (offset + dataLen > bytes.length) {
			truncated = true;
			break;
		}
		offset += dataLen;
	}

	return { targets: uniqueLower(targets), truncated };
}

function uniqueLower(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
	let value = 0n;
	for (const byte of bytes) {
		value = (value << 8n) + BigInt(byte);
	}
	return value;
}

function normalizeAddress(hex: string): string {
	// bytesToHex returns 0x-prefixed, lowercase.
	if (hex.length === 42) return hex;
	if (hex.startsWith("0x") && hex.length < 42) {
		return `0x${hex.slice(2).padStart(40, "0")}`;
	}
	return hex;
}
