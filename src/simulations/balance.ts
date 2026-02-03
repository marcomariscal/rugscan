import {
	type Address,
	createPublicClient,
	decodeAbiParameters,
	type Hex,
	hexToString,
	http,
	isAddress,
} from "viem";
import { decodeKnownCalldata } from "../analyzers/calldata/decoder";
import { isRecord, toBigInt } from "../analyzers/calldata/utils";
import { getChainConfig } from "../chains";
import type { CalldataInput } from "../schema";
import type {
	ApprovalChange,
	AssetChange,
	BalanceSimulationResult,
	Chain,
	ConfidenceLevel,
	Config,
} from "../types";
import { getAnvilClient } from "./anvil";
import { type ParsedTransfer, parseReceiptLogs } from "./logs";

const HIGH_BALANCE = 10n ** 22n;

const CURATED_TOKENS: Record<Chain, Address[]> = {
	ethereum: ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"],
	base: ["0x4200000000000000000000000000000000000006"],
	arbitrum: ["0x82af49447d8a07e3bd95bd0d56f35241523fbab1"],
	optimism: ["0x4200000000000000000000000000000000000006"],
	polygon: ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"],
};

const ERC20_BALANCE_ABI = [
	{
		type: "function",
		name: "balanceOf",
		stateMutability: "view",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
];

const ERC20_SYMBOL_STRING_ABI = [
	{
		type: "function",
		name: "symbol",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "string" }],
	},
];

const ERC20_SYMBOL_BYTES32_ABI = [
	{
		type: "function",
		name: "symbol",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "bytes32" }],
	},
];

const ERC20_DECIMALS_ABI = [
	{
		type: "function",
		name: "decimals",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "uint8" }],
	},
];

export async function simulateBalance(
	tx: CalldataInput,
	chain: Chain,
	config?: Config,
): Promise<BalanceSimulationResult> {
	const backend = config?.simulation?.backend ?? "anvil";
	const hints = buildFailureHints(tx);
	if (backend !== "anvil") {
		return simulateHeuristic(tx, chain, "Simulation backend set to heuristic.", hints);
	}
	if (!tx.from || !isAddress(tx.from)) {
		return simulateHeuristic(tx, chain, "Missing sender address; falling back to heuristic.", hints);
	}
	if (!isAddress(tx.to)) {
		return simulateHeuristic(tx, chain, "Invalid target address; falling back to heuristic.", hints);
	}
	if (!isHexString(tx.data)) {
		return simulateHeuristic(tx, chain, "Invalid calldata; falling back to heuristic.", hints);
	}

	try {
		return await simulateWithAnvil(tx, chain, config);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Anvil simulation failed";
		return simulateHeuristic(tx, chain, message, hints);
	}
}

async function simulateWithAnvil(
	tx: CalldataInput,
	chain: Chain,
	config?: Config,
): Promise<BalanceSimulationResult> {
	const instance = await getAnvilClient(chain, config);
	const client = instance.client;
	const from = tx.from && isAddress(tx.from) ? tx.from : null;
	const to = tx.to && isAddress(tx.to) ? tx.to : null;
	const data = isHexString(tx.data) ? tx.data : "0x";
	if (!from || !to) {
		return simulateHeuristic(
			tx,
			chain,
			"Invalid addresses; falling back to heuristic.",
			buildFailureHints(tx),
		);
	}

	const notes: string[] = [];
	let confidence: ConfidenceLevel = "high";

	const snapshotId = await client.snapshot();
	try {
		await client.impersonateAccount({ address: from });
		await client.setBalance({ address: from, value: HIGH_BALANCE });

		const isContractAccount = await checkContractAccount(from, chain, config);
		if (isContractAccount) {
			confidence = "low";
			notes.push("Sender is a contract account; simulation is best-effort.");
		}

		const txValue = parseValue(tx.value) ?? 0n;
		const tokenCandidates = new Set<Address>();
		for (const token of curatedTokens(chain)) {
			tokenCandidates.add(token);
		}

		const decoded = decodeKnownCalldata(tx.data);
		if (decoded?.standard === "erc20" && isAddress(tx.to)) {
			tokenCandidates.add(tx.to);
		}

		const nativeBefore = await client.getBalance({ address: from });
		const preBalances = await readTokenBalances(client, tokenCandidates, from, notes);

		type Receipt = Awaited<ReturnType<typeof client.waitForTransactionReceipt>>;
		let receipt: Receipt | null = null;
		try {
			const hash = await client.sendUnsignedTransaction({
				from,
				to,
				data,
				value: txValue,
			});
			receipt = await client.waitForTransactionReceipt({ hash });
		} catch (error) {
			const reason =
				(await attemptRevertReason(client, { from, to, data, value: txValue })) ??
				(error instanceof Error ? error.message : "Simulation failed");
			return simulateFailure(reason, notes, confidence, buildFailureHints(tx));
		}

		if (!receipt || receipt.status !== "success") {
			const reason =
				(await attemptRevertReason(client, {
					from,
					to,
					data,
					value: txValue,
					blockNumber: receipt?.blockNumber,
				})) ?? "Transaction reverted";
			return simulateFailure(reason, notes, confidence, buildFailureHints(tx));
		}

		const parsedLogs = await parseReceiptLogs(receipt.logs, client);
		notes.push(...parsedLogs.notes);
		confidence = minConfidence(confidence, parsedLogs.confidence);

		for (const transfer of parsedLogs.transfers) {
			if (transfer.standard === "erc20") {
				tokenCandidates.add(transfer.token);
			}
		}

		const missingTokens = new Set<Address>();
		for (const token of tokenCandidates) {
			if (!preBalances.has(token)) {
				missingTokens.add(token);
			}
		}

		if (missingTokens.size > 0) {
			const previousBlock = receipt.blockNumber > 0n ? receipt.blockNumber - 1n : undefined;
			if (previousBlock !== undefined) {
				const missingBalances = await readTokenBalances(
					client,
					missingTokens,
					from,
					notes,
					previousBlock,
				);
				for (const [token, balance] of missingBalances.entries()) {
					preBalances.set(token, balance);
				}
			} else {
				notes.push("Unable to read pre-transaction balances for newly discovered tokens.");
				confidence = minConfidence(confidence, "medium");
			}
		}

		const postBalances = await readTokenBalances(client, tokenCandidates, from, notes);

		const assetChanges: AssetChange[] = [];
		assetChanges.push(...buildErc20Changes(preBalances, postBalances));
		assetChanges.push(...buildNftChanges(parsedLogs.transfers, from));

		const approvals = parsedLogs.approvals
			.filter((approval) => approval.owner.toLowerCase() === from.toLowerCase())
			.map<ApprovalChange>((approval) => ({
				standard: approval.standard,
				token: approval.token,
				owner: approval.owner,
				spender: approval.spender,
				amount: approval.amount,
				tokenId: approval.tokenId,
				scope: approval.scope,
				approved: approval.approved,
			}));

		const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
		const nativeAfter = await client.getBalance({ address: from });
		const nativeDelta = nativeAfter - nativeBefore;
		const nativeDiff = nativeDelta + gasCost;

		const metadata = await readTokenMetadata(client, assetChanges, notes);
		const enrichedChanges = applyTokenMetadata(assetChanges, metadata);

		return {
			success: receipt.status === "success",
			gasUsed: receipt.gasUsed,
			effectiveGasPrice: receipt.effectiveGasPrice,
			nativeDiff,
			assetChanges: enrichedChanges,
			approvals,
			confidence,
			notes,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "Simulation failed";
		return simulateFailure(message, notes, confidence, buildFailureHints(tx));
	} finally {
		await client.revert({ id: snapshotId }).catch(() => undefined);
		await client.stopImpersonatingAccount({ address: from }).catch(() => undefined);
	}
}

function simulateFailure(
	message: string,
	notes: string[],
	confidence: ConfidenceLevel,
	hints: string[] = [],
): BalanceSimulationResult {
	const mergedNotes = [...notes, message, ...hints];
	return {
		success: false,
		revertReason: message,
		assetChanges: [],
		approvals: [],
		confidence: minConfidence(confidence, "low"),
		notes: mergedNotes,
	};
}

function simulateHeuristic(
	tx: CalldataInput,
	chain: Chain,
	reason: string,
	hints: string[] = [],
): BalanceSimulationResult {
	const notes: string[] = [
		reason,
		"Heuristic-only simulation (no Anvil fork).",
		...hints,
	].filter(Boolean);
	const assetChanges: AssetChange[] = [];
	const approvals: ApprovalChange[] = [];

	const from = tx.from && isAddress(tx.from) ? tx.from : null;
	const to = tx.to && isAddress(tx.to) ? tx.to : null;
	const value = parseValue(tx.value);
	const decoded = decodeKnownCalldata(tx.data);

	const nativeDiff = value && value !== 0n && from ? -value : undefined;

	if (decoded?.standard === "erc20" && isRecord(decoded.args) && to) {
		const amount = toBigInt(decoded.args.amount);
		const spender = typeof decoded.args.spender === "string" ? decoded.args.spender : null;
		const recipient = typeof decoded.args.to === "string" ? decoded.args.to : null;
		const fromArg = typeof decoded.args.from === "string" ? decoded.args.from : null;

		if (decoded.functionName === "approve" && amount !== null && spender && from) {
			approvals.push({
				standard: "erc20",
				token: to,
				owner: from,
				spender,
				amount,
				scope: "token",
			});
		}

		if (decoded.functionName === "transfer" && amount !== null && recipient && from) {
			assetChanges.push({
				assetType: "erc20",
				address: to,
				amount,
				direction: "out",
				counterparty: recipient,
			});
		}

		if (decoded.functionName === "transferFrom" && amount !== null) {
			if (from && fromArg && from.toLowerCase() === fromArg.toLowerCase()) {
				assetChanges.push({
					assetType: "erc20",
					address: to,
					amount,
					direction: "out",
					counterparty: recipient ?? undefined,
				});
			}
			if (from && recipient && from.toLowerCase() === recipient.toLowerCase()) {
				assetChanges.push({
					assetType: "erc20",
					address: to,
					amount,
					direction: "in",
					counterparty: fromArg ?? undefined,
				});
			}
		}
	}

	if (decoded?.standard === "eip2612" && isRecord(decoded.args) && to) {
		const owner = typeof decoded.args.owner === "string" ? decoded.args.owner : null;
		const spender = typeof decoded.args.spender === "string" ? decoded.args.spender : null;
		const amount = toBigInt(decoded.args.value);
		if (owner && spender && amount !== null) {
			approvals.push({
				standard: "erc20",
				token: to,
				owner,
				spender,
				amount,
				scope: "token",
			});
		}
	}

	const curated = curatedTokens(chain);
	if (curated.length > 0) {
		notes.push(`Curated token list: ${curated.join(", ")}`);
	}

	return {
		success: false,
		revertReason: reason,
		nativeDiff,
		assetChanges,
		approvals,
		confidence: "low",
		notes,
	};
}

function parseValue(value?: string): bigint | null {
	if (!value) return null;
	return toBigInt(value);
}

function curatedTokens(chain: Chain): Address[] {
	return CURATED_TOKENS[chain] ?? [];
}

function isHexString(value: string): value is Hex {
	return /^0x[0-9a-fA-F]*$/.test(value);
}

function buildFailureHints(tx: CalldataInput): string[] {
	const hints: string[] = [];
	if (!tx.from) {
		hints.push("Hint: missing sender (`from`) address.");
	}
	if (!tx.to) {
		hints.push("Hint: missing target (`to`) address.");
	}
	if (!tx.data || tx.data === "0x") {
		hints.push("Hint: missing calldata (`data`).");
	}
	const value = parseValue(tx.value);
	if (value === null || value === 0n) {
		hints.push("Hint: transaction value is 0; swaps often require non-zero ETH value.");
	}
	return hints;
}

async function attemptRevertReason(
	client: {
		call: (args: {
			from: Address;
			to: Address;
			data: Hex;
			value?: bigint;
			blockNumber?: bigint;
		}) => Promise<unknown>;
	},
	args: {
		from: Address;
		to: Address;
		data: Hex;
		value?: bigint;
		blockNumber?: bigint;
	},
): Promise<string | null> {
	try {
		await client.call({
			from: args.from,
			to: args.to,
			data: args.data,
			value: args.value,
			blockNumber: args.blockNumber,
		});
		return null;
	} catch (error) {
		return decodeRevertError(error);
	}
}

function decodeRevertError(error: unknown): string | null {
	const data = extractErrorData(error);
	if (data) {
		const selector = data.slice(0, 10).toLowerCase();
		if (selector === "0x08c379a0") {
			const encoded = `0x${data.slice(10)}`;
			try {
				const decoded = decodeAbiParameters([{ type: "string" }], encoded);
				const reason = decoded[0];
				if (typeof reason === "string" && reason.length > 0) {
					return reason;
				}
			} catch {
				return "Execution reverted";
			}
		}
		if (selector === "0x4e487b71") {
			const encoded = `0x${data.slice(10)}`;
			try {
				const decoded = decodeAbiParameters([{ type: "uint256" }], encoded);
				const code = decoded[0];
				if (typeof code === "bigint") {
					return `Panic(0x${code.toString(16)})`;
				}
			} catch {
				return "Panic";
			}
		}
		return `Custom error ${selector}`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return null;
}

function extractErrorData(error: unknown): Hex | null {
	if (!isRecord(error)) return null;
	if (isHexString(error.data)) return error.data;
	const cause = error.cause;
	if (cause) {
		const nested = extractErrorData(cause);
		if (nested) return nested;
	}
	const errorField = error.error;
	if (errorField) {
		const nested = extractErrorData(errorField);
		if (nested) return nested;
	}
	return null;
}

async function readTokenBalances(
	client: {
		readContract: (args: {
			address: Address;
			abi: typeof ERC20_BALANCE_ABI;
			functionName: string;
			args?: readonly unknown[];
			blockNumber?: bigint;
		}) => Promise<unknown>;
	},
	tokens: Set<Address>,
	account: Address,
	notes: string[],
	blockNumber?: bigint,
): Promise<Map<Address, bigint>> {
	const balances = new Map<Address, bigint>();
	const entries = Array.from(tokens);
	const results = await Promise.all(
		entries.map(async (token) => {
			try {
				const balance = await client.readContract({
					address: token,
					abi: ERC20_BALANCE_ABI,
					functionName: "balanceOf",
					args: [account],
					blockNumber,
				});
				return { token, balance };
			} catch {
				return { token, balance: null };
			}
		}),
	);
	for (const result of results) {
		if (typeof result.balance === "bigint") {
			balances.set(result.token, result.balance);
			continue;
		}
		notes.push(`Failed to read ERC-20 balance for ${result.token}`);
	}
	return balances;
}

async function readTokenMetadata(
	client: {
		readContract: (args: {
			address: Address;
			abi: typeof ERC20_SYMBOL_STRING_ABI;
			functionName: string;
			args?: readonly unknown[];
		}) => Promise<unknown>;
	},
	changes: AssetChange[],
	notes: string[],
): Promise<Map<Address, { symbol?: string; decimals?: number }>> {
	const tokens = Array.from(
		new Set(
			changes
				.filter((change) => change.assetType === "erc20" && change.address)
				.map((change) => change.address)
				.filter((address): address is Address => isAddress(address)),
		),
	);
	const metadata = new Map<Address, { symbol?: string; decimals?: number }>();
	if (tokens.length === 0) return metadata;

	const results = await Promise.all(
		tokens.map(async (token) => {
			const symbol = await readTokenSymbol(client, token);
			const decimals = await readTokenDecimals(client, token);
			return { token, symbol, decimals };
		}),
	);

	for (const result of results) {
		if (!result) continue;
		const { token, symbol, decimals } = result;
		if (!symbol && decimals === undefined) continue;
		metadata.set(token, { symbol, decimals });
	}

	if (metadata.size < tokens.length) {
		for (const token of tokens) {
			if (!metadata.has(token)) {
				notes.push(`Failed to read ERC-20 metadata for ${token}`);
			}
		}
	}

	return metadata;
}

async function readTokenSymbol(
	client: {
		readContract: (args: {
			address: Address;
			abi: typeof ERC20_SYMBOL_STRING_ABI;
			functionName: string;
			args?: readonly unknown[];
		}) => Promise<unknown>;
	},
	token: Address,
): Promise<string | undefined> {
	try {
		const result = await client.readContract({
			address: token,
			abi: ERC20_SYMBOL_STRING_ABI,
			functionName: "symbol",
		});
		if (typeof result === "string" && result.trim().length > 0) {
			return result.trim();
		}
	} catch {
		// fall through to bytes32 attempt
	}

	try {
		const result = await client.readContract({
			address: token,
			abi: ERC20_SYMBOL_BYTES32_ABI,
			functionName: "symbol",
		});
		if (typeof result === "string" && isHexString(result)) {
			const decoded = hexToString(result, { size: 32 });
			// biome-ignore lint/suspicious/noControlCharactersInRegex: null byte stripping
			const trimmed = decoded.replace(/\u0000/g, "").trim();
			return trimmed.length > 0 ? trimmed : undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function readTokenDecimals(
	client: {
		readContract: (args: {
			address: Address;
			abi: typeof ERC20_DECIMALS_ABI;
			functionName: string;
			args?: readonly unknown[];
		}) => Promise<unknown>;
	},
	token: Address,
): Promise<number | undefined> {
	try {
		const result = await client.readContract({
			address: token,
			abi: ERC20_DECIMALS_ABI,
			functionName: "decimals",
		});
		if (typeof result === "number" && Number.isFinite(result)) {
			return result;
		}
		if (typeof result === "bigint") {
			const value = Number(result);
			return Number.isFinite(value) ? value : undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function applyTokenMetadata(
	changes: AssetChange[],
	metadata: Map<Address, { symbol?: string; decimals?: number }>,
): AssetChange[] {
	if (metadata.size === 0) return changes;
	return changes.map((change) => {
		if (change.assetType !== "erc20" || !change.address) return change;
		if (!isAddress(change.address)) return change;
		const meta = metadata.get(change.address);
		if (!meta) return change;
		return {
			...change,
			symbol: meta.symbol ?? change.symbol,
			decimals: meta.decimals ?? change.decimals,
		};
	});
}

function buildErc20Changes(
	before: Map<Address, bigint>,
	after: Map<Address, bigint>,
): AssetChange[] {
	const changes: AssetChange[] = [];
	for (const [token, beforeBalance] of before.entries()) {
		const afterBalance = after.get(token);
		if (afterBalance === undefined) continue;
		const diff = afterBalance - beforeBalance;
		if (diff === 0n) continue;
		changes.push({
			assetType: "erc20",
			address: token,
			amount: diff < 0n ? -diff : diff,
			direction: diff < 0n ? "out" : "in",
		});
	}
	return changes;
}

function buildNftChanges(transfers: ParsedTransfer[], owner: Address): AssetChange[] {
	const changes: AssetChange[] = [];
	for (const transfer of transfers) {
		if (transfer.standard === "erc20") continue;
		if (transfer.from === owner && transfer.to === owner) continue;
		if (transfer.from !== owner && transfer.to !== owner) continue;
		const direction = transfer.to === owner ? "in" : "out";
		changes.push({
			assetType: transfer.standard,
			address: transfer.token,
			tokenId: transfer.tokenId,
			amount: transfer.amount,
			direction,
			counterparty: transfer.to === owner ? transfer.from : transfer.to,
		});
	}
	return changes;
}

function minConfidence(current: ConfidenceLevel, incoming: ConfidenceLevel): ConfidenceLevel {
	if (current === "low" || incoming === "low") return "low";
	if (current === "medium" || incoming === "medium") return "medium";
	return "high";
}

async function checkContractAccount(
	address: Address,
	chain: Chain,
	config?: Config,
): Promise<boolean> {
	const chainConfig = getChainConfig(chain);
	const rpcUrl = config?.simulation?.rpcUrl ?? config?.rpcUrls?.[chain] ?? chainConfig.rpcUrl;
	const client = createPublicClient({
		transport: http(rpcUrl),
	});
	try {
		const code = await client.getCode({ address });
		return Boolean(code && code !== "0x");
	} catch {
		return false;
	}
}
