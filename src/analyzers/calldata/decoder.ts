import type { Abi, AbiFunction, AbiParameter } from "viem";
import { decodeFunctionData, getAbiItem, parseAbiItem } from "viem";
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

export type DecodedCallSource = "known-abi" | "signature-db" | "contract-abi";
export type DecodedCallStandard = "erc20" | "eip2612" | undefined;

export interface DecodedCall {
	selector: string;
	signature: string;
	functionName: string;
	source: DecodedCallSource;
	standard?: DecodedCallStandard;
	args: Record<string, unknown> | unknown[];
	argNames?: string[];
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
		const argNames = buildArgNames(parsed.inputs, args.length);
		decoded.push({
			selector,
			signature,
			functionName: parsed.name,
			source: "signature-db",
			args,
			argNames,
			argTypes,
		});
	}
	return decoded;
}

export function decodeAbiCalldata(data: string, abi: Abi): DecodedCall | null {
	const selector = extractSelector(data);
	if (!selector) return null;

	try {
		const decoded = decodeFunctionData({ abi, data });
		const abiItem = resolveAbiFunction(abi, selector);
		const inputs = abiItem?.inputs ?? [];
		const values = coerceArgs(decoded.args, inputs);
		const argValues = values ?? [];
		const formattedValues = argValues.map((value) => formatDecodedValue(value));
		const argNames = inputs.length > 0 ? buildArgNames(inputs, formattedValues.length) : undefined;
		const args = argNames ? buildArgsRecord(argNames, formattedValues) : formattedValues;
		const signature = abiItem
			? buildSignature(decoded.functionName, inputs)
			: buildSignature(decoded.functionName, []);
		const argTypes = inputs.length > 0 ? inputs.map((input) => input.type) : undefined;

		return {
			selector,
			signature,
			functionName: decoded.functionName,
			source: "contract-abi",
			args,
			argNames,
			argTypes,
		};
	} catch {
		return null;
	}
}

function decodeArgs(abi: AbiFunction, data: string): unknown[] | null {
	try {
		const decoded = decodeFunctionData({ abi: [abi], data });
		if (!Array.isArray(decoded.args)) return null;
		return decoded.args.map((value) => formatDecodedValue(value));
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
	const formattedAmount = formatDecodedValue(amount);
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
		argNames: ["spender", "amount"],
	};
}

function decodeTransfer(selector: string, args: unknown): DecodedCall | null {
	const to = getArg(args, 0, "to");
	const amount = getArg(args, 1, "amount");
	if (typeof to !== "string" || amount === undefined) return null;
	const formattedAmount = formatDecodedValue(amount);
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
		argNames: ["to", "amount"],
	};
}

function decodeTransferFrom(selector: string, args: unknown): DecodedCall | null {
	const from = getArg(args, 0, "from");
	const to = getArg(args, 1, "to");
	const amount = getArg(args, 2, "amount");
	if (typeof from !== "string" || typeof to !== "string" || amount === undefined) return null;
	const formattedAmount = formatDecodedValue(amount);
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
		argNames: ["from", "to", "amount"],
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
	const formattedValue = formatDecodedValue(value);
	const formattedDeadline = formatDecodedValue(deadline);
	const formattedV = formatDecodedValue(v);
	const formattedR = formatDecodedValue(r);
	const formattedS = formatDecodedValue(s);
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
		argNames: ["owner", "spender", "value", "deadline", "v", "r", "s"],
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

function resolveAbiFunction(abi: Abi, selector: string): AbiFunction | undefined {
	try {
		const abiItem = getAbiItem({ abi, name: selector });
		if (isAbiFunction(abiItem)) {
			return abiItem;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function buildSignature(name: string, inputs: readonly AbiParameter[]): string {
	const types = inputs.map((input) => input.type).join(",");
	return `${name}(${types})`;
}

function buildArgNames(inputs: readonly AbiParameter[], valueCount: number): string[] {
	const names: string[] = [];
	const used = new Set<string>();
	for (let i = 0; i < valueCount; i += 1) {
		const input = inputs[i];
		const preferred = input && isNonEmptyString(input.name) ? input.name : `arg${i}`;
		let name = preferred;
		let suffix = 1;
		while (used.has(name)) {
			name = `${preferred}_${suffix}`;
			suffix += 1;
		}
		used.add(name);
		names.push(name);
	}
	return names;
}

function coerceArgs(args: unknown, inputs: readonly AbiParameter[]): unknown[] | null {
	if (Array.isArray(args)) return args;
	if (!isRecord(args)) return null;
	const values: unknown[] = [];
	for (let i = 0; i < inputs.length; i += 1) {
		const input = inputs[i];
		if (input && isNonEmptyString(input.name) && input.name in args) {
			values.push(args[input.name]);
			continue;
		}
		const indexKey = String(i);
		if (indexKey in args) {
			values.push(args[indexKey]);
			continue;
		}
	}
	return values.length > 0 ? values : null;
}

function buildArgsRecord(names: string[], values: unknown[]): Record<string, unknown> {
	const record: Record<string, unknown> = {};
	const count = Math.min(names.length, values.length);
	for (let i = 0; i < count; i += 1) {
		record[names[i]] = values[i];
	}
	return record;
}

function formatDecodedValue(value: unknown): unknown {
	const stringified = stringifyValue(value);
	return normalizeDecodedValue(stringified);
}

function normalizeDecodedValue(value: unknown): unknown {
	if (typeof value === "string") return normalizeAddress(value);
	if (Array.isArray(value)) {
		return value.map((entry) => normalizeDecodedValue(entry));
	}
	if (isRecord(value)) {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = normalizeDecodedValue(entry);
		}
		return result;
	}
	return value;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
