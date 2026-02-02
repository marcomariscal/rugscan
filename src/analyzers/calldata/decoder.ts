import type { Abi, AbiFunction } from "viem";
import { decodeFunctionData, parseAbiItem } from "viem";
import { extractSelector, isRecord, normalizeAddress, stringifyValue } from "./utils";

const ERC20_ABI: Abi = [
	{
		type: "function",
		name: "approve",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "transfer",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "transferFrom",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
];

const PERMIT_ABI: Abi = [
	{
		type: "function",
		name: "permit",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "spender", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "deadline", type: "uint256" },
			{ name: "v", type: "uint8" },
			{ name: "r", type: "bytes32" },
			{ name: "s", type: "bytes32" },
		],
		outputs: [],
	},
];

const KNOWN_ABI: Abi = [...ERC20_ABI, ...PERMIT_ABI];

const KNOWN_SIGNATURES: Record<string, string> = {
	approve: "approve(address,uint256)",
	transfer: "transfer(address,uint256)",
	transferFrom: "transferFrom(address,address,uint256)",
	permit: "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
};

export type DecodedCallSource = "known-abi" | "signature-db";
export type DecodedCallStandard = "erc20" | "eip2612" | undefined;

export interface DecodedCall {
	selector: string;
	signature: string;
	functionName: string;
	source: DecodedCallSource;
	standard?: DecodedCallStandard;
	args: Record<string, unknown> | unknown[];
	argTypes?: string[];
}

export function decodeKnownCalldata(data: string): DecodedCall | null {
	const selector = extractSelector(data);
	if (!selector) return null;

	try {
		const decoded = decodeFunctionData({ abi: KNOWN_ABI, data });
		const args = decoded.args;
		switch (decoded.functionName) {
			case "approve":
				return decodeApprove(selector, args);
			case "transfer":
				return decodeTransfer(selector, args);
			case "transferFrom":
				return decodeTransferFrom(selector, args);
			case "permit":
				return decodePermit(selector, args);
			default:
				return null;
		}
	} catch {
		return null;
	}
}

export function decodeSignatureCandidates(data: string, signatures: string[]): DecodedCall[] {
	const selector = extractSelector(data);
	if (!selector) return [];

	const decoded: DecodedCall[] = [];
	const seen = new Set<string>();
	for (const signature of signatures) {
		if (seen.has(signature)) continue;
		seen.add(signature);
		const parsed = parseSignature(signature);
		if (!parsed) continue;
		const args = decodeArgs(parsed, data);
		if (!args) continue;
		const argTypes = parsed.inputs.map((input) => input.type);
		decoded.push({
			selector,
			signature,
			functionName: parsed.name,
			source: "signature-db",
			args,
			argTypes,
		});
	}
	return decoded;
}

function decodeArgs(abi: AbiFunction, data: string): unknown[] | null {
	try {
		const decoded = decodeFunctionData({ abi: [abi], data });
		if (!Array.isArray(decoded.args)) return null;
		return decoded.args.map((value) => stringifyValue(value));
	} catch {
		return null;
	}
}

function parseSignature(signature: string): AbiFunction | null {
	const normalized = signature.startsWith("function ") ? signature : `function ${signature}`;
	try {
		const item = parseAbiItem(normalized);
		if (isAbiFunction(item)) {
			return item;
		}
		return null;
	} catch {
		return null;
	}
}

function isAbiFunction(value: unknown): value is AbiFunction {
	if (!isRecord(value)) return false;
	return value.type === "function" && typeof value.name === "string" && Array.isArray(value.inputs);
}

function decodeApprove(selector: string, args: unknown): DecodedCall | null {
	const spender = getArg(args, 0, "spender");
	const amount = getArg(args, 1, "amount");
	if (typeof spender !== "string" || amount === undefined) return null;
	const formattedAmount = stringifyValue(amount);
	if (formattedAmount === null) return null;
	return {
		selector,
		signature: KNOWN_SIGNATURES.approve,
		functionName: "approve",
		source: "known-abi",
		standard: "erc20",
		args: {
			spender: normalizeAddress(spender),
			amount: formattedAmount,
		},
	};
}

function decodeTransfer(selector: string, args: unknown): DecodedCall | null {
	const to = getArg(args, 0, "to");
	const amount = getArg(args, 1, "amount");
	if (typeof to !== "string" || amount === undefined) return null;
	const formattedAmount = stringifyValue(amount);
	if (formattedAmount === null) return null;
	return {
		selector,
		signature: KNOWN_SIGNATURES.transfer,
		functionName: "transfer",
		source: "known-abi",
		standard: "erc20",
		args: {
			to: normalizeAddress(to),
			amount: formattedAmount,
		},
	};
}

function decodeTransferFrom(selector: string, args: unknown): DecodedCall | null {
	const from = getArg(args, 0, "from");
	const to = getArg(args, 1, "to");
	const amount = getArg(args, 2, "amount");
	if (typeof from !== "string" || typeof to !== "string" || amount === undefined) return null;
	const formattedAmount = stringifyValue(amount);
	if (formattedAmount === null) return null;
	return {
		selector,
		signature: KNOWN_SIGNATURES.transferFrom,
		functionName: "transferFrom",
		source: "known-abi",
		standard: "erc20",
		args: {
			from: normalizeAddress(from),
			to: normalizeAddress(to),
			amount: formattedAmount,
		},
	};
}

function decodePermit(selector: string, args: unknown): DecodedCall | null {
	const owner = getArg(args, 0, "owner");
	const spender = getArg(args, 1, "spender");
	const value = getArg(args, 2, "value");
	const deadline = getArg(args, 3, "deadline");
	const v = getArg(args, 4, "v");
	const r = getArg(args, 5, "r");
	const s = getArg(args, 6, "s");
	if (typeof owner !== "string" || typeof spender !== "string") return null;
	const formattedValue = stringifyValue(value);
	const formattedDeadline = stringifyValue(deadline);
	const formattedV = stringifyValue(v);
	const formattedR = stringifyValue(r);
	const formattedS = stringifyValue(s);
	if (
		formattedValue === null ||
		formattedDeadline === null ||
		formattedV === null ||
		formattedR === null ||
		formattedS === null
	) {
		return null;
	}
	return {
		selector,
		signature: KNOWN_SIGNATURES.permit,
		functionName: "permit",
		source: "known-abi",
		standard: "eip2612",
		args: {
			owner: normalizeAddress(owner),
			spender: normalizeAddress(spender),
			value: formattedValue,
			deadline: formattedDeadline,
			v: formattedV,
			r: formattedR,
			s: formattedS,
		},
	};
}

function getArg(args: unknown, index: number, name: string): unknown {
	if (Array.isArray(args)) {
		return args[index];
	}
	if (isRecord(args) && name in args) {
		return args[name];
	}
	return undefined;
}
