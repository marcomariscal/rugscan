import {
	type DecodedCall,
	decodeUniversalRouterCommandLabels,
} from "../analyzers/calldata/decoder";
import { isAddress, isRecord, normalizeAddress } from "../analyzers/calldata/utils";
import { formatAmountWithDecimals, formatNativeWei } from "../format/amounts";
import { getKnownTokenMetadata } from "../tokens/known";

export interface IntentContext {
	contractAddress?: string;
	contractName?: string;
}

export interface IntentTemplate {
	id: string;
	match: (call: DecodedCall) => boolean;
	render: (call: DecodedCall, context: IntentContext) => string | null;
}

function formatValue(value: unknown): string | null {
	if (typeof value === "string") {
		return isAddress(value) ? normalizeAddress(value) : value;
	}
	if (typeof value === "number") return value.toString();
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "boolean") return value ? "true" : "false";
	return null;
}

function parseBoolean(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
	}
	if (typeof value === "string") {
		const normalized = value.toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return null;
}

function readArg(call: DecodedCall, name: string, index: number): unknown {
	const args = call.args;
	if (Array.isArray(args)) {
		return args[index];
	}
	if (isRecord(args)) {
		if (Object.hasOwn(args, name)) {
			return args[name];
		}
		const indexKey = `${index}`;
		if (Object.hasOwn(args, indexKey)) {
			return args[indexKey];
		}
	}
	return undefined;
}

function readStructField(value: unknown, name: string, index: number): unknown {
	if (Array.isArray(value)) {
		return value[index];
	}
	if (isRecord(value)) {
		if (Object.hasOwn(value, name)) {
			return value[name];
		}
		const indexKey = `${index}`;
		if (Object.hasOwn(value, indexKey)) {
			return value[indexKey];
		}
	}
	return undefined;
}

function tokenMetadata(context: IntentContext) {
	return getKnownTokenMetadata(context.contractAddress);
}

function tokenLabel(context: IntentContext): string {
	const metadata = tokenMetadata(context);
	return metadata?.symbol ?? context.contractName ?? context.contractAddress ?? "token";
}

function formatTokenAmount(value: unknown, context: IntentContext): string | null {
	const metadata = tokenMetadata(context);
	if (!metadata) {
		return formatValue(value);
	}
	return formatAmountWithDecimals(value, metadata.decimals, metadata.displayDecimals ?? 4);
}

function collectionLabel(context: IntentContext): string {
	return context.contractName ?? "NFT";
}

function extractPathTokens(path: unknown): { tokenIn?: string; tokenOut?: string } {
	if (Array.isArray(path) && path.length > 0) {
		const tokenIn = formatValue(path[0]) ?? undefined;
		const tokenOut = formatValue(path[path.length - 1]) ?? undefined;
		return { tokenIn, tokenOut };
	}
	if (typeof path === "string") {
		return extractTokensFromPathBytes(path);
	}
	return {};
}

function extractTokensFromPathBytes(path: string): { tokenIn?: string; tokenOut?: string } {
	if (!path.startsWith("0x")) return {};
	const raw = path.slice(2);
	if (raw.length < 40) return {};
	const tokenIn = normalizeAddress(`0x${raw.slice(0, 40)}`);
	const tokenOut = normalizeAddress(`0x${raw.slice(raw.length - 40)}`);
	return { tokenIn, tokenOut };
}

function extractTokenAmount(value: unknown): { token?: string; amount?: string } {
	if (isRecord(value)) {
		const token = formatValue(value.token);
		const amount = formatValue(value.amount ?? value.value ?? value.requestedAmount);
		if (token || amount) {
			return { token: token ?? undefined, amount: amount ?? undefined };
		}
		if (Object.hasOwn(value, "permitted")) {
			return extractTokenAmount(value.permitted);
		}
		if (Object.hasOwn(value, "details")) {
			const details = value.details;
			if (Array.isArray(details) && details.length > 0) {
				return extractTokenAmount(details[0]);
			}
			return extractTokenAmount(details);
		}
	}
	if (Array.isArray(value)) {
		const token = formatValue(value[0]);
		const amount = formatValue(value[1]);
		if (token || amount) {
			return { token: token ?? undefined, amount: amount ?? undefined };
		}
		if (value.length > 0) {
			return extractTokenAmount(value[0]);
		}
	}
	return {};
}

function extractSpender(value: unknown): string | undefined {
	const spender = formatValue(readStructField(value, "spender", 1));
	return spender ?? undefined;
}

function extractRecipient(value: unknown): string | undefined {
	if (Array.isArray(value) && value.length > 0) {
		return extractRecipient(value[0]);
	}
	const recipient = formatValue(readStructField(value, "to", 0));
	return recipient ?? undefined;
}

function extractUniversalRouterCommandLabels(call: DecodedCall): string[] {
	const commandsDecoded = readArg(call, "commandsDecoded", 3);
	if (Array.isArray(commandsDecoded)) {
		const labels: string[] = [];
		for (const entry of commandsDecoded) {
			if (!isRecord(entry)) continue;
			const command = entry.command;
			if (typeof command !== "string" || command.length === 0) continue;
			const allowRevert = entry.allowRevert;
			labels.push(allowRevert === true ? `${command} (allow-revert)` : command);
		}
		if (labels.length > 0) {
			return labels;
		}
	}

	const commands = readArg(call, "commands", 0);
	if (typeof commands === "string" && commands.startsWith("0x")) {
		return decodeUniversalRouterCommandLabels(commands);
	}

	return [];
}

function summarizeUniversalRouterCommands(labels: string[]): string | null {
	if (labels.length === 0) return null;
	const maxSteps = 4;
	const visible = labels.slice(0, maxSteps);
	const suffix = labels.length > maxSteps ? ` +${labels.length - maxSteps} more` : "";
	return `${visible.join(" → ")}${suffix}`;
}

function summarizeNestedCallLabels(labels: string[]): string | null {
	if (labels.length === 0) return null;
	const maxSteps = 3;
	const visible = labels.slice(0, maxSteps);
	const suffix = labels.length > maxSteps ? ` +${labels.length - maxSteps} more` : "";
	return `${visible.join(" + ")}${suffix}`;
}

function extractNestedCallLabels(call: DecodedCall): string[] {
	const nested = readArg(call, "innerCalls", 1);
	if (!Array.isArray(nested)) return [];
	const labels: string[] = [];
	for (const entry of nested) {
		if (!isRecord(entry)) continue;
		const functionName = entry.functionName;
		if (typeof functionName === "string" && functionName.length > 0) {
			labels.push(functionName);
			continue;
		}
		const signature = entry.signature;
		if (typeof signature === "string" && signature.length > 0) {
			labels.push(signature);
		}
	}
	return labels;
}

const KNOWN_ADDRESS_LABELS: Record<string, string> = {
	"0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
};

function formatAddressWithKnownLabel(value: string): string {
	return KNOWN_ADDRESS_LABELS[value.toLowerCase()] ?? normalizeAddress(value);
}

function summarizeSafeInnerCall(call: DecodedCall): string | null {
	const innerCall = readArg(call, "innerCall", 3);
	if (!isRecord(innerCall)) return null;
	const functionName = innerCall.functionName;
	if (typeof functionName !== "string" || functionName.length === 0) return null;

	if (functionName === "approve") {
		const args = innerCall.args;
		if (!isRecord(args)) return null;
		const spender = formatValue(args.spender);
		const amount = args.amount ?? args.value;
		const tokenAddress = formatValue(readArg(call, "to", 0));
		const context: IntentContext = {
			contractAddress: tokenAddress ?? undefined,
		};
		const token = tokenLabel(context);
		const amountLabel = formatTokenAmount(amount, context);
		if (spender && amountLabel) {
			return `${token} approve(${formatAddressWithKnownLabel(spender)}, ${amountLabel})`;
		}
	}

	return functionName;
}

const erc20Approve: IntentTemplate = {
	id: "erc20-approve",
	match: (call) => call.standard === "erc20" && call.functionName === "approve",
	render: (call, context) => {
		const spender = formatValue(readArg(call, "spender", 0));
		const amount = formatTokenAmount(readArg(call, "amount", 1), context);
		if (!spender || !amount) return null;
		return `Approve ${spender} to spend ${amount} ${tokenLabel(context)}`;
	},
};

const erc20Transfer: IntentTemplate = {
	id: "erc20-transfer",
	match: (call) => call.standard === "erc20" && call.functionName === "transfer",
	render: (call, context) => {
		const to = formatValue(readArg(call, "to", 0));
		const amount = formatTokenAmount(readArg(call, "amount", 1), context);
		if (!to || !amount) return null;
		return `Transfer ${amount} ${tokenLabel(context)} to ${to}`;
	},
};

const erc20TransferFrom: IntentTemplate = {
	id: "erc20-transfer-from",
	match: (call) => call.functionName === "transferFrom",
	render: (call, context) => {
		const from = formatValue(readArg(call, "from", 0));
		const to = formatValue(readArg(call, "to", 1));
		const amount =
			formatTokenAmount(readArg(call, "amount", 2), context) ??
			formatValue(readArg(call, "tokenId", 2)) ??
			formatValue(readArg(call, "id", 2));
		if (!from || !to || !amount) return null;
		return `Transfer ${amount} ${tokenLabel(context)} from ${from} to ${to}`;
	},
};

const erc721SafeTransfer: IntentTemplate = {
	id: "erc721-safe-transfer-from",
	match: (call) => call.functionName === "safeTransferFrom",
	render: (call, context) => {
		const from = formatValue(readArg(call, "from", 0));
		const to = formatValue(readArg(call, "to", 1));
		const tokenId = formatValue(readArg(call, "tokenId", 2)) ?? formatValue(readArg(call, "id", 2));
		if (!from || !to || !tokenId) return null;
		return `Transfer ${collectionLabel(context)} #${tokenId} from ${from} to ${to}`;
	},
};

const erc721SetApprovalForAll: IntentTemplate = {
	id: "erc721-set-approval-for-all",
	match: (call) => call.functionName === "setApprovalForAll",
	render: (call, context) => {
		const operator = formatValue(readArg(call, "operator", 0));
		const approved = parseBoolean(readArg(call, "approved", 1));
		if (!operator || approved === null) return null;
		const collection = collectionLabel(context);
		if (approved) {
			return `Approve ${operator} to manage all ${collection} tokens`;
		}
		return `Revoke ${operator} approval for all ${collection} tokens`;
	},
};

const aaveBorrow: IntentTemplate = {
	id: "aave-borrow",
	match: (call) => call.functionName === "borrow",
	render: (call) => {
		const asset = formatValue(readArg(call, "asset", 0));
		const amount = formatValue(readArg(call, "amount", 1));
		if (!asset || !amount) return null;
		return `Borrow ${amount} ${asset} from Aave`;
	},
};

const aaveRepay: IntentTemplate = {
	id: "aave-repay",
	match: (call) => call.functionName === "repay",
	render: (call) => {
		const asset = formatValue(readArg(call, "asset", 0));
		const amount = formatValue(readArg(call, "amount", 1));
		if (!asset || !amount) return null;
		return `Repay ${amount} ${asset} to Aave`;
	},
};

const aaveSupply: IntentTemplate = {
	id: "aave-supply",
	match: (call) => call.functionName === "supply",
	render: (call) => {
		const asset = formatValue(readArg(call, "asset", 0));
		const amount = formatValue(readArg(call, "amount", 1));
		if (!asset || !amount) return null;
		return `Supply ${amount} ${asset} to Aave`;
	},
};

const aaveWithdraw: IntentTemplate = {
	id: "aave-withdraw",
	match: (call) => call.functionName === "withdraw",
	render: (call) => {
		const asset = formatValue(readArg(call, "asset", 0));
		const amount = formatValue(readArg(call, "amount", 1));
		if (!asset || !amount) return null;
		return `Withdraw ${amount} ${asset} from Aave`;
	},
};

const aaveGatewayDepositEth: IntentTemplate = {
	id: "aave-gateway-deposit-eth",
	match: (call) => call.functionName === "depositETH",
	render: () => "Supply ETH to Aave",
};

const aaveGatewayWithdrawEth: IntentTemplate = {
	id: "aave-gateway-withdraw-eth",
	match: (call) =>
		call.functionName === "withdrawETH" || call.functionName === "withdrawETHWithPermit",
	render: () => "Withdraw ETH from Aave",
};

const aaveGatewayBorrowEth: IntentTemplate = {
	id: "aave-gateway-borrow-eth",
	match: (call) => call.functionName === "borrowETH",
	render: () => "Borrow ETH from Aave",
};

const aaveGatewayRepayEth: IntentTemplate = {
	id: "aave-gateway-repay-eth",
	match: (call) => call.functionName === "repayETH",
	render: () => "Repay ETH to Aave",
};

const uniswapUniversalRouterExecute: IntentTemplate = {
	id: "uniswap-universal-router-execute",
	match: (call) =>
		call.functionName === "execute" &&
		(call.signature === "execute(bytes,bytes[],uint256)" ||
			call.signature === "execute(bytes,bytes[])"),
	render: (call) => {
		const labels = extractUniversalRouterCommandLabels(call);
		const summary = summarizeUniversalRouterCommands(labels);
		if (!summary) return "Uniswap Universal Router execution";
		return `Uniswap Universal Router: ${summary}`;
	},
};

const routerMulticall: IntentTemplate = {
	id: "router-multicall",
	match: (call) => call.functionName === "multicall",
	render: (call) => {
		const labels = extractNestedCallLabels(call);
		const summary = summarizeNestedCallLabels(labels);
		if (!summary) return "multicall";
		return `multicall: ${summary}`;
	},
};

const safeExecTransaction: IntentTemplate = {
	id: "safe-exec-transaction",
	match: (call) => call.functionName === "execTransaction",
	render: (call) => {
		const innerSummary = summarizeSafeInnerCall(call);
		if (innerSummary) {
			return `Safe exec → ${innerSummary}`;
		}
		const valueLabel = formatNativeWei(readArg(call, "value", 1), 4);
		const to = formatValue(readArg(call, "to", 0));
		if (to && valueLabel) {
			return `Safe exec → send ${valueLabel} ETH to ${to}`;
		}
		return "Safe exec transaction";
	},
};

const oneInchSwap: IntentTemplate = {
	id: "1inch-swap",
	match: (call) =>
		call.functionName === "swap" &&
		(call.selector === "0x12aa3caf" || call.selector === "0x07ed2379"),
	render: () => "1inch aggregated swap",
};

const oneInchUniswapV3Swap: IntentTemplate = {
	id: "1inch-uniswap-v3-swap",
	match: (call) => call.functionName === "uniswapV3Swap",
	render: (call) => {
		const pools = readArg(call, "pools", 2);
		const poolCount = Array.isArray(pools) ? pools.length : 0;
		if (poolCount > 0) {
			return `1inch swap via Uniswap V3 (${poolCount} pool${poolCount === 1 ? "" : "s"})`;
		}
		return "1inch swap via Uniswap V3";
	},
};

const uniswapV2ExactTokensForTokens: IntentTemplate = {
	id: "uniswap-v2-exact-tokens-for-tokens",
	match: (call) => call.functionName === "swapExactTokensForTokens",
	render: (call) => {
		const amountIn = formatValue(readArg(call, "amountIn", 0));
		const path = readArg(call, "path", 2);
		const { tokenIn, tokenOut } = extractPathTokens(path);
		if (!amountIn || !tokenIn || !tokenOut) return null;
		return `Swap ${amountIn} ${tokenIn} for ${tokenOut}`;
	},
};

const uniswapV2TokensForExactTokens: IntentTemplate = {
	id: "uniswap-v2-tokens-for-exact-tokens",
	match: (call) => call.functionName === "swapTokensForExactTokens",
	render: (call) => {
		const amountOut = formatValue(readArg(call, "amountOut", 0));
		const amountInMax = formatValue(readArg(call, "amountInMax", 1));
		const path = readArg(call, "path", 2);
		const { tokenIn, tokenOut } = extractPathTokens(path);
		if (!amountOut || !amountInMax || !tokenIn || !tokenOut) return null;
		return `Swap up to ${amountInMax} ${tokenIn} for ${amountOut} ${tokenOut}`;
	},
};

const uniswapV2ExactEthForTokens: IntentTemplate = {
	id: "uniswap-v2-exact-eth-for-tokens",
	match: (call) => call.functionName === "swapExactETHForTokens",
	render: (call) => {
		const amountOutMin = formatValue(readArg(call, "amountOutMin", 0));
		const path = readArg(call, "path", 1);
		const { tokenOut } = extractPathTokens(path);
		if (!tokenOut) return null;
		if (amountOutMin) {
			return `Swap ETH for at least ${amountOutMin} ${tokenOut}`;
		}
		return `Swap ETH for ${tokenOut}`;
	},
};

const uniswapV2EthForExactTokens: IntentTemplate = {
	id: "uniswap-v2-eth-for-exact-tokens",
	match: (call) => call.functionName === "swapETHForExactTokens",
	render: (call) => {
		const amountOut = formatValue(readArg(call, "amountOut", 0));
		const path = readArg(call, "path", 1);
		const { tokenOut } = extractPathTokens(path);
		if (!amountOut || !tokenOut) return null;
		return `Swap ETH for ${amountOut} ${tokenOut}`;
	},
};

const uniswapV2ExactTokensForEth: IntentTemplate = {
	id: "uniswap-v2-exact-tokens-for-eth",
	match: (call) => call.functionName === "swapExactTokensForETH",
	render: (call) => {
		const amountIn = formatValue(readArg(call, "amountIn", 0));
		const path = readArg(call, "path", 2);
		const { tokenIn } = extractPathTokens(path);
		if (!amountIn || !tokenIn) return null;
		return `Swap ${amountIn} ${tokenIn} for ETH`;
	},
};

const uniswapV2TokensForExactEth: IntentTemplate = {
	id: "uniswap-v2-tokens-for-exact-eth",
	match: (call) => call.functionName === "swapTokensForExactETH",
	render: (call) => {
		const amountOut = formatValue(readArg(call, "amountOut", 0));
		const amountInMax = formatValue(readArg(call, "amountInMax", 1));
		const path = readArg(call, "path", 2);
		const { tokenIn } = extractPathTokens(path);
		if (!amountOut || !amountInMax || !tokenIn) return null;
		return `Swap up to ${amountInMax} ${tokenIn} for ${amountOut} ETH`;
	},
};

const uniswapV3ExactInputSingle: IntentTemplate = {
	id: "uniswap-v3-exact-input-single",
	match: (call) => call.functionName === "exactInputSingle",
	render: (call) => {
		const params = readArg(call, "params", 0);
		const tokenIn = formatValue(readStructField(params, "tokenIn", 0));
		const tokenOut = formatValue(readStructField(params, "tokenOut", 1));
		const amountIn = formatValue(readStructField(params, "amountIn", 4));
		if (!tokenIn || !tokenOut || !amountIn) return null;
		return `Swap ${amountIn} ${tokenIn} for ${tokenOut}`;
	},
};

const uniswapV3ExactOutputSingle: IntentTemplate = {
	id: "uniswap-v3-exact-output-single",
	match: (call) => call.functionName === "exactOutputSingle",
	render: (call) => {
		const params = readArg(call, "params", 0);
		const tokenIn = formatValue(readStructField(params, "tokenIn", 0));
		const tokenOut = formatValue(readStructField(params, "tokenOut", 1));
		const amountOut = formatValue(readStructField(params, "amountOut", 4));
		const amountInMax = formatValue(readStructField(params, "amountInMaximum", 5));
		if (!tokenIn || !tokenOut || !amountOut) return null;
		if (amountInMax) {
			return `Swap up to ${amountInMax} ${tokenIn} for ${amountOut} ${tokenOut}`;
		}
		return `Swap ${amountOut} ${tokenOut} for ${tokenIn}`;
	},
};

const uniswapV3ExactInput: IntentTemplate = {
	id: "uniswap-v3-exact-input",
	match: (call) => call.functionName === "exactInput",
	render: (call) => {
		const params = readArg(call, "params", 0);
		const path = readStructField(params, "path", 0);
		const amountIn = formatValue(readStructField(params, "amountIn", 3));
		const { tokenIn, tokenOut } = extractPathTokens(path);
		if (!tokenIn || !tokenOut || !amountIn) return null;
		return `Swap ${amountIn} ${tokenIn} for ${tokenOut}`;
	},
};

const uniswapV3ExactOutput: IntentTemplate = {
	id: "uniswap-v3-exact-output",
	match: (call) => call.functionName === "exactOutput",
	render: (call) => {
		const params = readArg(call, "params", 0);
		const path = readStructField(params, "path", 0);
		const amountOut = formatValue(readStructField(params, "amountOut", 3));
		const amountInMax = formatValue(readStructField(params, "amountInMaximum", 4));
		const { tokenIn, tokenOut } = extractPathTokens(path);
		const actualTokenIn = tokenOut;
		const actualTokenOut = tokenIn;
		if (!actualTokenIn || !actualTokenOut || !amountOut) return null;
		if (amountInMax) {
			return `Swap up to ${amountInMax} ${actualTokenIn} for ${amountOut} ${actualTokenOut}`;
		}
		return `Swap ${amountOut} ${actualTokenOut} for ${actualTokenIn}`;
	},
};

const permit2Permit: IntentTemplate = {
	id: "permit2-permit",
	match: (call) => call.functionName === "permit" && call.standard !== "eip2612",
	render: (call) => {
		const permit = readArg(call, "permit", 1);
		const spender = extractSpender(permit);
		const { token, amount } = extractTokenAmount(permit);
		if (!spender && !token && !amount) return null;
		if (spender && token && amount) {
			return `Permit2: Approve ${spender} to spend ${amount} ${token}`;
		}
		if (spender && token) {
			return `Permit2: Approve ${spender} to spend ${token}`;
		}
		if (spender) {
			return `Permit2: Approve ${spender} to spend tokens`;
		}
		if (token && amount) {
			return `Permit2: Approve ${amount} ${token}`;
		}
		return null;
	},
};

const permit2PermitTransferFrom: IntentTemplate = {
	id: "permit2-permit-transfer-from",
	match: (call) => call.functionName === "permitTransferFrom",
	render: (call) => {
		const permit = readArg(call, "permit", 0);
		const transferDetails = readArg(call, "transferDetails", 1);
		const recipient = extractRecipient(transferDetails);
		const permitTokenAmount = extractTokenAmount(permit);
		const transferTokenAmount = extractTokenAmount(transferDetails);
		const token = transferTokenAmount.token ?? permitTokenAmount.amount;
		const amount = transferTokenAmount.amount ?? permitTokenAmount.amount;
		if (!recipient || !token || !amount) return null;
		return `Permit2: Transfer ${amount} ${token} to ${recipient}`;
	},
};

const wethDeposit: IntentTemplate = {
	id: "weth-deposit",
	match: (call) => call.functionName === "deposit" && call.selector === "0xd0e30db0",
	render: (_call, context) => `Wrap ETH → ${context.contractName ?? "WETH"}`,
};

const wethWithdraw: IntentTemplate = {
	id: "weth-withdraw",
	match: (call) => call.functionName === "withdraw" && call.selector === "0x2e1a7d4d",
	render: (call, context) => {
		const amount = readArg(call, "wad", 0);
		const formatted = formatValue(amount);
		return formatted
			? `Unwrap ${formatted} ${context.contractName ?? "WETH"} → ETH`
			: `Unwrap ${context.contractName ?? "WETH"} → ETH`;
	},
};

export const INTENT_TEMPLATES: IntentTemplate[] = [
	erc20Approve,
	erc20Transfer,
	erc20TransferFrom,
	erc721SafeTransfer,
	erc721SetApprovalForAll,
	aaveBorrow,
	aaveRepay,
	aaveSupply,
	aaveWithdraw,
	aaveGatewayDepositEth,
	aaveGatewayWithdrawEth,
	aaveGatewayBorrowEth,
	aaveGatewayRepayEth,
	uniswapUniversalRouterExecute,
	routerMulticall,
	safeExecTransaction,
	oneInchSwap,
	oneInchUniswapV3Swap,
	uniswapV2ExactTokensForTokens,
	uniswapV2TokensForExactTokens,
	uniswapV2ExactEthForTokens,
	uniswapV2EthForExactTokens,
	uniswapV2ExactTokensForEth,
	uniswapV2TokensForExactEth,
	uniswapV3ExactInputSingle,
	uniswapV3ExactOutputSingle,
	uniswapV3ExactInput,
	uniswapV3ExactOutput,
	permit2Permit,
	permit2PermitTransferFrom,
	wethDeposit,
	wethWithdraw,
];
