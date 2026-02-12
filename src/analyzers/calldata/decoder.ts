import type { Abi, AbiFunction, AbiParameter } from "viem";
import { decodeAbiParameters, decodeFunctionData, getAbiItem, isHex, parseAbiItem } from "viem";
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

const UNIVERSAL_ROUTER_EXECUTE_ABI: Abi = [
	{
		type: "function",
		name: "execute",
		stateMutability: "payable",
		inputs: [
			{ name: "commands", type: "bytes" },
			{ name: "inputs", type: "bytes[]" },
			{ name: "deadline", type: "uint256" },
		],
		outputs: [],
	},
	{
		type: "function",
		name: "execute",
		stateMutability: "payable",
		inputs: [
			{ name: "commands", type: "bytes" },
			{ name: "inputs", type: "bytes[]" },
		],
		outputs: [],
	},
];

const MULTICALL_ABI: Abi = [
	{
		type: "function",
		name: "multicall",
		stateMutability: "payable",
		inputs: [{ name: "data", type: "bytes[]" }],
		outputs: [{ name: "results", type: "bytes[]" }],
	},
	{
		type: "function",
		name: "multicall",
		stateMutability: "payable",
		inputs: [
			{ name: "deadline", type: "uint256" },
			{ name: "data", type: "bytes[]" },
		],
		outputs: [{ name: "results", type: "bytes[]" }],
	},
];

const SAFE_EXEC_TRANSACTION_ABI: Abi = [
	{
		type: "function",
		name: "execTransaction",
		stateMutability: "payable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "data", type: "bytes" },
			{ name: "operation", type: "uint8" },
			{ name: "safeTxGas", type: "uint256" },
			{ name: "baseGas", type: "uint256" },
			{ name: "gasPrice", type: "uint256" },
			{ name: "gasToken", type: "address" },
			{ name: "refundReceiver", type: "address" },
			{ name: "signatures", type: "bytes" },
		],
		outputs: [{ name: "success", type: "bool" }],
	},
];

const UNIVERSAL_ROUTER_COMMAND_LABELS: Record<number, string> = {
	0: "V3_SWAP_EXACT_IN",
	1: "V3_SWAP_EXACT_OUT",
	2: "PERMIT2_TRANSFER_FROM",
	3: "PERMIT2_PERMIT_BATCH",
	4: "SWEEP",
	5: "TRANSFER",
	6: "PAY_PORTION",
	8: "V2_SWAP_EXACT_IN",
	9: "V2_SWAP_EXACT_OUT",
	10: "PERMIT2_PERMIT",
	11: "WRAP_ETH",
	12: "UNWRAP_WETH",
	13: "PERMIT2_TRANSFER_FROM_BATCH",
	14: "BALANCE_CHECK_ERC20",
	16: "V4_SWAP",
	17: "V3_POSITION_MANAGER_PERMIT",
	18: "V3_POSITION_MANAGER_CALL",
	19: "V4_INITIALIZE_POOL",
	20: "V4_POSITION_MANAGER_CALL",
	33: "EXECUTE_SUB_PLAN",
};

interface LocalSelectorFallback {
	signature: string;
	functionName: string;
}

interface UniversalRouterCommandStep {
	index: number;
	opcode: string;
	command: string;
	allowRevert: boolean;
	details?: Record<string, unknown>;
}

const LOCAL_SELECTOR_FALLBACKS: Record<string, LocalSelectorFallback> = {
	// Uniswap Universal Router
	"0x3593564c": {
		signature: "execute(bytes,bytes[],uint256)",
		functionName: "execute",
	},
	"0x24856bc3": {
		signature: "execute(bytes,bytes[])",
		functionName: "execute",
	},
	// Uniswap V2 Router
	"0x38ed1739": {
		signature: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
		functionName: "swapExactTokensForTokens",
	},
	"0x8803dbee": {
		signature: "swapTokensForExactTokens(uint256,uint256,address[],address,uint256)",
		functionName: "swapTokensForExactTokens",
	},
	"0x7ff36ab5": {
		signature: "swapExactETHForTokens(uint256,address[],address,uint256)",
		functionName: "swapExactETHForTokens",
	},
	"0xfb3bdb41": {
		signature: "swapETHForExactTokens(uint256,address[],address,uint256)",
		functionName: "swapETHForExactTokens",
	},
	"0x18cbafe5": {
		signature: "swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
		functionName: "swapExactTokensForETH",
	},
	"0x4a25d94a": {
		signature: "swapTokensForExactETH(uint256,uint256,address[],address,uint256)",
		functionName: "swapTokensForExactETH",
	},
	// Uniswap V3 Router (legacy + router02 variants)
	"0x414bf389": {
		signature: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
		functionName: "exactInputSingle",
	},
	"0xdb3e2198": {
		signature:
			"exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
		functionName: "exactOutputSingle",
	},
	"0xeecd097a": {
		signature: "exactInput((bytes,address,uint256,uint256,uint256,uint256))",
		functionName: "exactInput",
	},
	"0x2c025145": {
		signature: "exactOutput((bytes,address,uint256,uint256,uint256,uint256))",
		functionName: "exactOutput",
	},
	"0x04e45aaf": {
		signature: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
		functionName: "exactInputSingle",
	},
	"0x5023b4df": {
		signature: "exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))",
		functionName: "exactOutputSingle",
	},
	"0xc04b8d59": {
		signature: "exactInput((bytes,address,uint256,uint256,uint256))",
		functionName: "exactInput",
	},
	"0xf28c0498": {
		signature: "exactOutput((bytes,address,uint256,uint256,uint256))",
		functionName: "exactOutput",
	},
	// Router multicall wrappers
	"0xac9650d8": {
		signature: "multicall(bytes[])",
		functionName: "multicall",
	},
	"0x5ae401dc": {
		signature: "multicall(uint256,bytes[])",
		functionName: "multicall",
	},
	"0x49404b7c": {
		signature: "unwrapWETH9(uint256,address)",
		functionName: "unwrapWETH9",
	},
	// Safe
	"0x6a761202": {
		signature:
			"execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
		functionName: "execTransaction",
	},
	// 1inch Aggregation Router
	"0x12aa3caf": {
		signature:
			"swap(address,(address,address,address,address,uint256,uint256,uint256),bytes,bytes)",
		functionName: "swap",
	},
};

const MAX_NESTED_DECODE_DEPTH = 2;

interface NestedDecodedCall {
	selector: string;
	signature: string;
	functionName: string;
	args?: Record<string, unknown> | unknown[];
	argNames?: string[];
}

export type DecodedCallSource = "known-abi" | "signature-db" | "contract-abi" | "local-selector";
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

export function decodeKnownCalldata(data: string, depth = 0): DecodedCall | null {
	const selector = extractSelector(data);
	if (!selector) return null;
	if (!isHex(data)) return null;

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
		return decodeLocalSelectorFallback(selector, data, depth);
	}
}

function decodeLocalSelectorFallback(
	selector: string,
	data: string,
	depth: number,
): DecodedCall | null {
	const normalized = selector.toLowerCase();
	const fallback = LOCAL_SELECTOR_FALLBACKS[normalized];
	if (!fallback) return null;

	if (fallback.functionName === "execute") {
		const decoded = decodeUniversalRouterExecute(data, normalized, fallback.signature);
		if (decoded) return decoded;
	}

	if (fallback.functionName === "multicall") {
		const decoded = decodeMulticall(data, normalized, fallback.signature, depth);
		if (decoded) return decoded;
	}

	if (fallback.functionName === "execTransaction") {
		const decoded = decodeSafeExecTransaction(data, normalized, fallback.signature, depth);
		if (decoded) return decoded;
	}

	return {
		selector: normalized,
		signature: fallback.signature,
		functionName: fallback.functionName,
		source: "local-selector",
		args: [],
	};
}

export function decodeSignatureCandidates(data: string, signatures: string[]): DecodedCall[] {
	const selector = extractSelector(data);
	if (!selector) return [];
	if (!isHex(data)) return [];

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
	if (!isHex(data)) return null;

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
	if (!isHex(data)) return null;
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

function decodeUniversalRouterExecute(
	data: string,
	selector: string,
	fallbackSignature: string,
): DecodedCall | null {
	if (!isHex(data)) return null;
	try {
		const decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_EXECUTE_ABI, data });
		const commandsValue = getArg(decoded.args, 0, "commands");
		const inputsValue = getArg(decoded.args, 1, "inputs");
		const deadlineValue = getArg(decoded.args, 2, "deadline");
		if (typeof commandsValue !== "string" || !isHex(commandsValue)) return null;
		if (!Array.isArray(inputsValue)) return null;

		const inputs: string[] = [];
		for (const input of inputsValue) {
			if (typeof input !== "string" || !isHex(input)) return null;
			inputs.push(input.toLowerCase());
		}

		const commandSteps = decodeUniversalRouterCommandSteps(commandsValue, inputs);
		const commandLabels = commandSteps.map((step) =>
			step.allowRevert ? `${step.command} (allow-revert)` : step.command,
		);

		const args: Record<string, unknown> = {
			commands: commandsValue.toLowerCase(),
			inputCount: inputs.length,
			commandLabels,
			commandsDecoded: commandSteps,
		};
		const argNames = ["commands", "inputCount", "commandLabels", "commandsDecoded"];

		const formattedDeadline = formatDecodedValue(deadlineValue);
		if (formattedDeadline !== undefined && formattedDeadline !== null) {
			args.deadline = formattedDeadline;
			argNames.push("deadline");
		}

		const signature =
			fallbackSignature.length > 0
				? fallbackSignature
				: Array.isArray(decoded.args) && decoded.args.length >= 3
					? "execute(bytes,bytes[],uint256)"
					: "execute(bytes,bytes[])";

		return {
			selector,
			signature,
			functionName: "execute",
			source: "local-selector",
			args,
			argNames,
		};
	} catch {
		return null;
	}
}

function decodeMulticall(
	data: string,
	selector: string,
	fallbackSignature: string,
	depth: number,
): DecodedCall | null {
	if (!isHex(data)) return null;
	try {
		const decoded = decodeFunctionData({ abi: MULTICALL_ABI, data });
		const dataValue = getArg(decoded.args, 0, "data");
		const dataArray = Array.isArray(dataValue) ? dataValue : getArg(decoded.args, 1, "data");
		if (!Array.isArray(dataArray)) return null;

		const nestedCalls: Record<string, unknown>[] = [];
		for (const entry of dataArray) {
			if (typeof entry !== "string" || !isHex(entry)) continue;
			const nested = decodeNestedKnownCalldata(entry, depth);
			if (!nested) continue;
			nestedCalls.push({
				selector: nested.selector,
				signature: nested.signature,
				functionName: nested.functionName,
				...(nested.args !== undefined ? { args: nested.args } : {}),
				...(nested.argNames ? { argNames: nested.argNames } : {}),
			});
		}

		const args: Record<string, unknown> = {
			callCount: dataArray.length,
			innerCalls: nestedCalls,
		};
		const argNames = ["callCount", "innerCalls"];

		const deadline = getArg(decoded.args, 0, "deadline");
		const formattedDeadline = formatDecodedValue(deadline);
		if (
			Array.isArray(decoded.args) &&
			decoded.args.length > 1 &&
			formattedDeadline !== undefined &&
			formattedDeadline !== null
		) {
			args.deadline = formattedDeadline;
			argNames.push("deadline");
		}

		return {
			selector,
			signature: fallbackSignature,
			functionName: "multicall",
			source: "local-selector",
			args,
			argNames,
		};
	} catch {
		return null;
	}
}

function decodeSafeExecTransaction(
	data: string,
	selector: string,
	fallbackSignature: string,
	depth: number,
): DecodedCall | null {
	if (!isHex(data)) return null;
	try {
		const decoded = decodeFunctionData({ abi: SAFE_EXEC_TRANSACTION_ABI, data });
		const toValue = getArg(decoded.args, 0, "to");
		const valueValue = getArg(decoded.args, 1, "value");
		const dataValue = getArg(decoded.args, 2, "data");
		const operationValue = getArg(decoded.args, 3, "operation");
		if (typeof toValue !== "string" || typeof dataValue !== "string") return null;

		const innerDecoded = decodeNestedKnownCalldata(dataValue, depth);
		const args: Record<string, unknown> = {
			to: normalizeAddress(toValue),
			value: formatDecodedValue(valueValue),
			operation: formatDecodedValue(operationValue),
		};
		const argNames = ["to", "value", "operation"];

		if (innerDecoded) {
			args.innerCall = {
				selector: innerDecoded.selector,
				signature: innerDecoded.signature,
				functionName: innerDecoded.functionName,
				...(innerDecoded.args !== undefined ? { args: innerDecoded.args } : {}),
				...(innerDecoded.argNames ? { argNames: innerDecoded.argNames } : {}),
			};
			argNames.push("innerCall");
		}

		return {
			selector,
			signature: fallbackSignature,
			functionName: "execTransaction",
			source: "local-selector",
			args,
			argNames,
		};
	} catch {
		return null;
	}
}

function decodeNestedKnownCalldata(data: string, depth: number): NestedDecodedCall | null {
	if (depth >= MAX_NESTED_DECODE_DEPTH) return null;
	const decoded = decodeKnownCalldata(data, depth + 1);
	if (!decoded) return null;
	return {
		selector: decoded.selector,
		signature: decoded.signature,
		functionName: decoded.functionName,
		...(decoded.args !== undefined ? { args: decoded.args } : {}),
		...(decoded.argNames ? { argNames: decoded.argNames } : {}),
	};
}

export function decodeUniversalRouterCommandLabels(commands: string): string[] {
	const steps = decodeUniversalRouterCommandSteps(commands, []);
	return steps.map((step) => (step.allowRevert ? `${step.command} (allow-revert)` : step.command));
}

function decodeUniversalRouterCommandSteps(
	commands: string,
	inputs: string[],
): UniversalRouterCommandStep[] {
	const bytes = hexToBytes(commands);
	if (!bytes) return [];

	const steps: UniversalRouterCommandStep[] = [];
	for (let index = 0; index < bytes.length; index += 1) {
		const commandByte = bytes[index];
		const opcode = commandByte & 0x3f;
		const label =
			UNIVERSAL_ROUTER_COMMAND_LABELS[opcode] ??
			`COMMAND_0x${opcode.toString(16).padStart(2, "0")}`;
		const input = inputs[index];
		const details = input ? decodeUniversalRouterCommandDetails(opcode, input) : undefined;
		steps.push({
			index,
			opcode: `0x${opcode.toString(16).padStart(2, "0")}`,
			command: label,
			allowRevert: (commandByte & 0x80) !== 0,
			...(details ? { details } : {}),
		});
	}
	return steps;
}

function decodeUniversalRouterCommandDetails(
	opcode: number,
	input: string,
): Record<string, unknown> | undefined {
	if (!isHex(input)) return undefined;

	if (opcode === 0x00 || opcode === 0x01) {
		const decoded = decodeAbiTuple(input, [
			{ name: "recipient", type: "address" },
			{ name: opcode === 0x00 ? "amountIn" : "amountOut", type: "uint256" },
			{ name: opcode === 0x00 ? "amountOutMin" : "amountInMax", type: "uint256" },
			{ name: "path", type: "bytes" },
			{ name: "payerIsUser", type: "bool" },
		]);
		if (!decoded) return undefined;
		const path = valueAt(decoded, 3);
		const tokenPair = extractTokensFromEncodedPath(path);
		return pruneUndefined({
			recipient: normalizeAddressString(valueAt(decoded, 0)),
			[opcode === 0x00 ? "amountIn" : "amountOut"]: formatDecodedValue(valueAt(decoded, 1)),
			[opcode === 0x00 ? "amountOutMin" : "amountInMax"]: formatDecodedValue(valueAt(decoded, 2)),
			tokenIn: tokenPair.tokenIn,
			tokenOut: tokenPair.tokenOut,
			payerIsUser: valueAt(decoded, 4),
		});
	}

	if (opcode === 0x08 || opcode === 0x09) {
		const decoded = decodeAbiTuple(input, [
			{ name: "recipient", type: "address" },
			{ name: opcode === 0x08 ? "amountIn" : "amountOut", type: "uint256" },
			{ name: opcode === 0x08 ? "amountOutMin" : "amountInMax", type: "uint256" },
			{ name: "path", type: "address[]" },
			{ name: "payerIsUser", type: "bool" },
		]);
		if (!decoded) return undefined;
		const tokenPair = extractTokensFromAddressPath(valueAt(decoded, 3));
		return pruneUndefined({
			recipient: normalizeAddressString(valueAt(decoded, 0)),
			[opcode === 0x08 ? "amountIn" : "amountOut"]: formatDecodedValue(valueAt(decoded, 1)),
			[opcode === 0x08 ? "amountOutMin" : "amountInMax"]: formatDecodedValue(valueAt(decoded, 2)),
			tokenIn: tokenPair.tokenIn,
			tokenOut: tokenPair.tokenOut,
			payerIsUser: valueAt(decoded, 4),
		});
	}

	if (opcode === 0x0b || opcode === 0x0c) {
		const decoded = decodeAbiTuple(input, [
			{ name: "recipient", type: "address" },
			{ name: "amountMin", type: "uint256" },
		]);
		if (!decoded) return undefined;
		return pruneUndefined({
			recipient: normalizeAddressString(valueAt(decoded, 0)),
			amountMin: formatDecodedValue(valueAt(decoded, 1)),
		});
	}

	if (opcode === 0x04) {
		const decoded = decodeAbiTuple(input, [
			{ name: "token", type: "address" },
			{ name: "recipient", type: "address" },
			{ name: "amountMin", type: "uint256" },
		]);
		if (!decoded) return undefined;
		return pruneUndefined({
			token: normalizeAddressString(valueAt(decoded, 0)),
			recipient: normalizeAddressString(valueAt(decoded, 1)),
			amountMin: formatDecodedValue(valueAt(decoded, 2)),
		});
	}

	if (opcode === 0x05) {
		const decoded = decodeAbiTuple(input, [
			{ name: "token", type: "address" },
			{ name: "recipient", type: "address" },
			{ name: "value", type: "uint256" },
		]);
		if (!decoded) return undefined;
		return pruneUndefined({
			token: normalizeAddressString(valueAt(decoded, 0)),
			recipient: normalizeAddressString(valueAt(decoded, 1)),
			value: formatDecodedValue(valueAt(decoded, 2)),
		});
	}

	if (opcode === 0x06) {
		const decoded = decodeAbiTuple(input, [
			{ name: "token", type: "address" },
			{ name: "recipient", type: "address" },
			{ name: "bips", type: "uint256" },
		]);
		if (!decoded) return undefined;
		return pruneUndefined({
			token: normalizeAddressString(valueAt(decoded, 0)),
			recipient: normalizeAddressString(valueAt(decoded, 1)),
			bips: formatDecodedValue(valueAt(decoded, 2)),
		});
	}

	if (opcode === 0x10) {
		const decoded = decodeAbiTuple(input, [
			{ name: "actions", type: "bytes" },
			{ name: "params", type: "bytes[]" },
		]);
		if (!decoded) return undefined;
		const actions = valueAt(decoded, 0);
		const params = valueAt(decoded, 1);
		const actionCount =
			typeof actions === "string" && isHex(actions)
				? Math.max(0, (actions.length - 2) / 2)
				: undefined;
		const paramsCount = Array.isArray(params) ? params.length : undefined;
		return pruneUndefined({ actionCount, paramsCount });
	}

	return undefined;
}

function decodeAbiTuple(input: string, params: AbiParameter[]): readonly unknown[] | null {
	if (!isHex(input)) return null;
	try {
		return decodeAbiParameters(params, input);
	} catch {
		return null;
	}
}

function valueAt(values: readonly unknown[], index: number): unknown {
	if (index < 0 || index >= values.length) return undefined;
	return values[index];
}

function hexToBytes(value: string): number[] | null {
	if (!isHex(value)) return null;
	const raw = value.startsWith("0x") ? value.slice(2) : value;
	if (raw.length === 0) return [];
	if (raw.length % 2 !== 0) return null;
	const bytes: number[] = [];
	for (let index = 0; index < raw.length; index += 2) {
		const byte = Number.parseInt(raw.slice(index, index + 2), 16);
		if (Number.isNaN(byte)) return null;
		bytes.push(byte);
	}
	return bytes;
}

function extractTokensFromEncodedPath(path: unknown): { tokenIn?: string; tokenOut?: string } {
	if (typeof path !== "string" || !path.startsWith("0x")) return {};
	const raw = path.slice(2);
	if (raw.length < 40) return {};
	const tokenIn = normalizeAddress(`0x${raw.slice(0, 40)}`);
	const tokenOut = normalizeAddress(`0x${raw.slice(raw.length - 40)}`);
	return { tokenIn, tokenOut };
}

function extractTokensFromAddressPath(path: unknown): { tokenIn?: string; tokenOut?: string } {
	if (!Array.isArray(path) || path.length === 0) return {};
	const first = path[0];
	const last = path[path.length - 1];
	const tokenIn = normalizeAddressString(first);
	const tokenOut = normalizeAddressString(last);
	return { tokenIn, tokenOut };
}

function normalizeAddressString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return normalizeAddress(value);
}

function pruneUndefined(details: Record<string, unknown>): Record<string, unknown> | undefined {
	const filteredEntries = Object.entries(details).filter((entry) => entry[1] !== undefined);
	if (filteredEntries.length === 0) return undefined;
	const filtered: Record<string, unknown> = {};
	for (const [key, value] of filteredEntries) {
		filtered[key] = value;
	}
	return filtered;
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
