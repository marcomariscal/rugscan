import type { DecodedCall } from "../analyzers/calldata/decoder";
import { isAddress, isRecord, normalizeAddress } from "../analyzers/calldata/utils";

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
		if (Object.prototype.hasOwnProperty.call(args, name)) {
			return args[name];
		}
		const indexKey = `${index}`;
		if (Object.prototype.hasOwnProperty.call(args, indexKey)) {
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
		if (Object.prototype.hasOwnProperty.call(value, name)) {
			return value[name];
		}
		const indexKey = `${index}`;
		if (Object.prototype.hasOwnProperty.call(value, indexKey)) {
			return value[indexKey];
		}
	}
	return undefined;
}

function tokenLabel(context: IntentContext): string {
	return context.contractName ?? context.contractAddress ?? "token";
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
		if (Object.prototype.hasOwnProperty.call(value, "permitted")) {
			return extractTokenAmount(value.permitted);
		}
		if (Object.prototype.hasOwnProperty.call(value, "details")) {
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

const erc20Approve: IntentTemplate = {
	id: "erc20-approve",
	match: (call) => call.standard === "erc20" && call.functionName === "approve",
	render: (call, context) => {
		const spender = formatValue(readArg(call, "spender", 0));
		const amount = formatValue(readArg(call, "amount", 1));
		if (!spender || !amount) return null;
		return `Approve ${spender} to spend ${amount} ${tokenLabel(context)}`;
	},
};

const erc20Transfer: IntentTemplate = {
	id: "erc20-transfer",
	match: (call) => call.standard === "erc20" && call.functionName === "transfer",
	render: (call, context) => {
		const to = formatValue(readArg(call, "to", 0));
		const amount = formatValue(readArg(call, "amount", 1));
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
			formatValue(readArg(call, "amount", 2)) ??
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
		const tokenId =
			formatValue(readArg(call, "tokenId", 2)) ?? formatValue(readArg(call, "id", 2));
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
		const token = transferTokenAmount.token ?? permitTokenAmount.token;
		const amount = transferTokenAmount.amount ?? permitTokenAmount.amount;
		if (!recipient || !token || !amount) return null;
		return `Permit2: Transfer ${amount} ${token} to ${recipient}`;
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
];
