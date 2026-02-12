import {
	type Address,
	decodeAbiParameters,
	type Hex,
	hexToString,
	isAddress,
	sliceHex,
} from "viem";
import { decodeKnownCalldata } from "../analyzers/calldata/decoder";
import { isRecord, toBigInt } from "../analyzers/calldata/utils";
import { isPlainEthTransfer } from "../calldata/plain-transfer";
import { getChainConfig } from "../chains";
import type { CalldataInput } from "../schema";
import type { TimingStore } from "../timing";
import { nowMs } from "../timing";
import type {
	ApprovalChange,
	AssetChange,
	BalanceSimulationResult,
	Chain,
	Config,
	SimulationConfidenceLevel,
} from "../types";
import { AnvilUnavailableError, getAnvilClient } from "./anvil";
import { buildApprovalDiffs } from "./approval-diffs";
import { buildWalletFastErc20Changes, selectWalletFastErc20Tokens } from "./delta-engine";
import { type ParsedApproval, type ParsedTransfer, parseReceiptLogs } from "./logs";
import { buildSimulationNotRun } from "./verdict";

const HIGH_BALANCE = 10n ** 22n;

const WALLET_FAST_BUDGET_MS = 5000;
const WALLET_FAST_MAX_ERC20_TOKENS = 12;

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

type SimulationMode = "default" | "wallet";

type AnvilInstance = Awaited<ReturnType<typeof getAnvilClient>>;
type AnvilClient = AnvilInstance["client"];

export async function simulateBalance(
	tx: CalldataInput,
	chain: Chain,
	config?: Config,
	timings?: TimingStore,
	options?: { offline?: boolean; mode?: SimulationMode; budgetMs?: number },
): Promise<BalanceSimulationResult> {
	const backend = config?.simulation?.backend ?? "anvil";
	const offline = options?.offline ?? false;
	const hints = buildFailureHints(tx);
	if (backend !== "anvil") {
		return simulateHeuristic(tx, chain, "Simulation backend set to heuristic.", hints);
	}
	if (!tx.from || !isAddress(tx.from)) {
		return simulateHeuristic(
			tx,
			chain,
			"Missing sender address; falling back to heuristic.",
			hints,
		);
	}
	if (!isAddress(tx.to)) {
		return simulateHeuristic(
			tx,
			chain,
			"Invalid target address; falling back to heuristic.",
			hints,
		);
	}
	if (!isHexString(tx.data)) {
		return simulateHeuristic(tx, chain, "Invalid calldata; falling back to heuristic.", hints);
	}

	try {
		return await simulateWithAnvil(tx, chain, config, timings, {
			offline,
			mode: options?.mode,
			budgetMs: options?.budgetMs,
		});
	} catch (error) {
		if (error instanceof AnvilUnavailableError) {
			const notRun = buildSimulationNotRun(tx);
			return {
				...notRun,
				notes: [
					...notRun.notes,
					`Hint: ${error.message}`,
					"Hint: install Foundry (includes Anvil): https://getfoundry.sh (then run foundryup)",
				],
			};
		}
		const message =
			error instanceof Error
				? toUserFacingSimulationFailure(error.message)
				: "Simulation backend failed";
		return simulateHeuristic(tx, chain, message, hints);
	}
}

function resolveAnvilRpcUrlCandidates(
	chain: Chain,
	config?: Config,
	options?: { offline?: boolean },
): string[] {
	const offline = options?.offline ?? false;

	const explicit = config?.simulation?.rpcUrl;
	if (explicit) return [explicit];

	const configured = config?.rpcUrls?.[chain];
	if (configured) return [configured];

	if (offline) return [];

	const defaultUrl = getChainConfig(chain).rpcUrl;
	if (chain !== "ethereum") return [defaultUrl];

	const candidates = [
		"https://eth.drpc.org",
		"https://ethereum.publicnode.com",
		"https://eth.llamarpc.com",
		defaultUrl,
	];

	const seen = new Set<string>();
	const unique: string[] = [];
	for (const url of candidates) {
		if (seen.has(url)) continue;
		seen.add(url);
		unique.push(url);
	}
	return unique;
}

function withSimulationRpcUrl(config: Config | undefined, rpcUrl: string): Config {
	return {
		...config,
		simulation: {
			...config?.simulation,
			rpcUrl,
		},
	};
}

async function simulateWithAnvil(
	tx: CalldataInput,
	chain: Chain,
	config?: Config,
	timings?: TimingStore,
	options?: { offline?: boolean; mode?: SimulationMode; budgetMs?: number },
): Promise<BalanceSimulationResult> {
	const offline = options?.offline ?? false;
	const rpcUrls = resolveAnvilRpcUrlCandidates(chain, config, { offline });

	let lastError: unknown;
	for (const rpcUrl of rpcUrls) {
		const attemptConfig = withSimulationRpcUrl(config, rpcUrl);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				return await simulateWithAnvilOnce(tx, chain, attemptConfig, timings, {
					offline,
					mode: options?.mode,
					budgetMs: options?.budgetMs,
				});
			} catch (error) {
				lastError = error;
			}
		}
	}

	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error("Anvil simulation failed");
}

async function simulateWithAnvilOnce(
	tx: CalldataInput,
	chain: Chain,
	config?: Config,
	timings?: TimingStore,
	options?: { offline?: boolean; mode?: SimulationMode; budgetMs?: number },
): Promise<BalanceSimulationResult> {
	const offline = options?.offline ?? false;
	const getClientStarted = nowMs();
	const instance = await getAnvilClient(chain, config, { offline });
	timings?.add("anvil.getClient", nowMs() - getClientStarted);
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
	let balanceConfidence: SimulationConfidenceLevel = "high";
	let approvalsConfidence: SimulationConfidenceLevel = "high";

	return await instance.runExclusive(async () => {
		const warmResetResult = await instance.resetFork();
		timings?.add("anvil.warmReset", warmResetResult.ms);
		timings?.add(
			warmResetResult.usedAnvilReset ? "anvil.warmReset.anvil_reset" : "anvil.warmReset.snapshot",
			warmResetResult.ms,
		);

		const simulationStarted = nowMs();
		try {
			await client.impersonateAccount({ address: from });
			await client.setBalance({ address: from, value: HIGH_BALANCE });

			const contractCheckStarted = nowMs();
			const senderIsContract = await checkContractAccountOnFork(client, from);
			timings?.add("simulation.senderContractCheck", nowMs() - contractCheckStarted);
			if (senderIsContract) {
				notes.push("Sender is a contract account; applying contract-sender confidence heuristic.");
			}

			const txValue = parseValue(tx.value) ?? 0n;
			if ((options?.mode ?? "default") === "wallet") {
				const budgetMs = options?.budgetMs ?? WALLET_FAST_BUDGET_MS;
				return await simulateWithAnvilWalletFast({
					tx,
					client,
					from,
					to,
					data,
					txValue,
					timings,
					notes,
					balanceConfidence,
					approvalsConfidence,
					senderIsContract,
					budgetMs,
				});
			}

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
					(error instanceof Error
						? toUserFacingSimulationFailure(error.message)
						: "Simulation failed");
				return simulateFailure(
					reason,
					notes,
					balanceConfidence,
					approvalsConfidence,
					buildFailureHints(tx),
				);
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
				return simulateFailure(
					reason,
					notes,
					balanceConfidence,
					approvalsConfidence,
					buildFailureHints(tx),
				);
			}

			const parsedLogs = await parseReceiptLogs(receipt.logs, client);
			notes.push(...parsedLogs.notes);
			balanceConfidence = minConfidence(balanceConfidence, parsedLogs.confidence);
			approvalsConfidence = minConfidence(approvalsConfidence, parsedLogs.confidence);

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
					balanceConfidence = minConfidence(balanceConfidence, "medium");
				}
			}

			const postBalances = await readTokenBalances(client, tokenCandidates, from, notes);

			const assetChanges: AssetChange[] = [];
			assetChanges.push(...buildErc20Changes(preBalances, postBalances));
			assetChanges.push(...buildNftChanges(parsedLogs.transfers, from));

			const actorApprovalsFromLogs = filterApprovalsByOwner(parsedLogs.approvals, from);
			const actorApprovals = appendApproveCalldataSlotIfMissing({
				approvals: actorApprovalsFromLogs,
				tx,
				owner: from,
				token: to,
			});
			const hasApprovalSlots = actorApprovals.length > 0;
			let approvals = mapParsedApprovalsToChanges(actorApprovals);
			if (hasApprovalSlots) {
				const previousBlock = receipt.blockNumber > 0n ? receipt.blockNumber - 1n : undefined;
				if (previousBlock === undefined) {
					notes.push("Unable to read pre-transaction approvals (missing previous block).");
					approvalsConfidence = minConfidence(approvalsConfidence, "medium");
				} else {
					try {
						const diffResult = await buildApprovalDiffs(actorApprovals, client, {
							beforeBlock: previousBlock,
							afterBlock: receipt.blockNumber,
						});
						approvals = diffResult.approvals;
						approvalsConfidence = minConfidence(approvalsConfidence, diffResult.confidence);
						notes.push(...diffResult.notes);
					} catch (error) {
						const message = error instanceof Error ? error.message : "unknown error";
						notes.push(`Approval diff stage failed; using event-derived approvals (${message}).`);
						approvalsConfidence = minConfidence(approvalsConfidence, "low");
					}
				}
			}

			const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
			const nativeAfter = await client.getBalance({ address: from });
			const nativeDelta = nativeAfter - nativeBefore;
			const nativeDiff = nativeDelta + gasCost;

			const approvalTokenChanges: AssetChange[] = approvals
				.filter((approval) => approval.standard === "erc20" || approval.standard === "permit2")
				.map((approval) => ({
					assetType: "erc20",
					address: approval.token,
					direction: "in",
				}));

			const metadata = await readTokenMetadata(
				client,
				[...assetChanges, ...approvalTokenChanges],
				notes,
			);
			const enrichedChanges = applyTokenMetadata(assetChanges, metadata);
			const enrichedApprovals = applyApprovalMetadata(approvals, metadata);
			const adjustedConfidence = applyContractSenderConfidenceHeuristic({
				senderIsContract,
				balanceConfidence,
				approvalsConfidence,
				balanceChanges: enrichedChanges,
				approvalChanges: enrichedApprovals,
				notes,
			});

			return {
				success: receipt.status === "success",
				gasUsed: receipt.gasUsed,
				effectiveGasPrice: receipt.effectiveGasPrice,
				nativeDiff,
				balances: {
					changes: enrichedChanges,
					confidence: adjustedConfidence.balanceConfidence,
				},
				approvals: {
					changes: enrichedApprovals,
					confidence: adjustedConfidence.approvalsConfidence,
				},
				notes,
			};
		} catch (error) {
			const message =
				error instanceof Error ? toUserFacingSimulationFailure(error.message) : "Simulation failed";
			return simulateFailure(
				message,
				notes,
				balanceConfidence,
				approvalsConfidence,
				buildFailureHints(tx),
			);
		} finally {
			const simulationEnded = nowMs();
			timings?.add("simulation.run", simulationEnded - simulationStarted);

			await client.stopImpersonatingAccount({ address: from }).catch(() => undefined);
		}
	});
}

export interface WalletFastSimulationOptions {
	tx: CalldataInput;
	client: AnvilClient;
	from: Address;
	to: Address;
	data: Hex;
	txValue: bigint;
	timings?: TimingStore;
	notes: string[];
	balanceConfidence: SimulationConfidenceLevel;
	approvalsConfidence: SimulationConfidenceLevel;
	senderIsContract?: boolean;
	budgetMs: number;
}

export async function simulateWithAnvilWalletFast(
	options: WalletFastSimulationOptions,
): Promise<BalanceSimulationResult> {
	const startedAt = nowMs();
	let balanceConfidence = options.balanceConfidence;
	let approvalsConfidence = options.approvalsConfidence;

	const nativeBefore = await options.client.getBalance({ address: options.from });

	type Receipt = Awaited<ReturnType<AnvilClient["waitForTransactionReceipt"]>>;
	let receipt: Receipt | null = null;
	try {
		const hash = await options.client.sendUnsignedTransaction({
			from: options.from,
			to: options.to,
			data: options.data,
			value: options.txValue,
		});
		receipt = await options.client.waitForTransactionReceipt({ hash });
	} catch (error) {
		const reason =
			(await attemptRevertReason(options.client, {
				from: options.from,
				to: options.to,
				data: options.data,
				value: options.txValue,
			})) ?? (error instanceof Error ? error.message : "Simulation failed");
		return simulateFailure(
			reason,
			options.notes,
			balanceConfidence,
			approvalsConfidence,
			buildFailureHints(options.tx),
		);
	}

	if (!receipt || receipt.status !== "success") {
		const reason =
			(await attemptRevertReason(options.client, {
				from: options.from,
				to: options.to,
				data: options.data,
				value: options.txValue,
				blockNumber: receipt?.blockNumber,
			})) ?? "Transaction reverted";
		return simulateFailure(
			reason,
			options.notes,
			balanceConfidence,
			approvalsConfidence,
			buildFailureHints(options.tx),
		);
	}

	const parseLogsStarted = nowMs();
	const parsedLogs = await parseReceiptLogs(receipt.logs, options.client);
	options.timings?.add("simulation.walletFast.parseLogs", nowMs() - parseLogsStarted);
	options.notes.push(...parsedLogs.notes);
	balanceConfidence = minConfidence(balanceConfidence, parsedLogs.confidence);
	approvalsConfidence = minConfidence(approvalsConfidence, parsedLogs.confidence);

	const selectTokensStarted = nowMs();
	const selected = selectWalletFastErc20Tokens({
		actor: options.from,
		transfers: parsedLogs.transfers,
		maxTokens: WALLET_FAST_MAX_ERC20_TOKENS,
	});
	options.timings?.add("simulation.walletFast.selectTokens", nowMs() - selectTokensStarted);
	if (selected.truncated) {
		options.notes.push(
			`Wallet-fast token set truncated to ${WALLET_FAST_MAX_ERC20_TOKENS} ERC-20 contracts.`,
		);
		balanceConfidence = minConfidence(balanceConfidence, "medium");
	}

	const tokenSet = new Set<Address>(selected.tokens);
	const preBalances = new Map<Address, bigint>();
	const postBalances = new Map<Address, bigint>();

	if (tokenSet.size > 0) {
		const previousBlock = receipt.blockNumber > 0n ? receipt.blockNumber - 1n : undefined;
		if (previousBlock !== undefined) {
			const preBalancesStarted = nowMs();
			const loadedPreBalances = await readTokenBalances(
				options.client,
				tokenSet,
				options.from,
				options.notes,
				previousBlock,
			);
			options.timings?.add(
				"simulation.walletFast.readTokenBalances.before",
				nowMs() - preBalancesStarted,
			);
			for (const [token, balance] of loadedPreBalances.entries()) {
				preBalances.set(token, balance);
			}
		} else {
			options.notes.push(
				"Unable to read pre-transaction balances for wallet-fast token set (missing previous block).",
			);
			balanceConfidence = minConfidence(balanceConfidence, "medium");
		}

		const postBalancesStarted = nowMs();
		const loadedPostBalances = await readTokenBalances(
			options.client,
			tokenSet,
			options.from,
			options.notes,
		);
		options.timings?.add(
			"simulation.walletFast.readTokenBalances.after",
			nowMs() - postBalancesStarted,
		);
		for (const [token, balance] of loadedPostBalances.entries()) {
			postBalances.set(token, balance);
		}
	}

	const assetChanges = buildWalletFastErc20Changes({
		actor: options.from,
		transfers: parsedLogs.transfers,
		tokens: selected.tokens,
		before: preBalances,
		after: postBalances,
	});
	assetChanges.push(...buildNftChanges(parsedLogs.transfers, options.from));

	const actorApprovalsFromLogs = filterApprovalsByOwner(parsedLogs.approvals, options.from);
	const actorApprovals = appendApproveCalldataSlotIfMissing({
		approvals: actorApprovalsFromLogs,
		tx: options.tx,
		owner: options.from,
		token: options.to,
	});
	const hasActorApprovalEvents = actorApprovalsFromLogs.length > 0;
	const hasApprovalSlots = actorApprovals.length > 0;
	const hasSyntheticApproveSlot = actorApprovals.length > actorApprovalsFromLogs.length;
	let approvals = mapParsedApprovalsToChanges(actorApprovals);

	const approvalsStarted = nowMs();
	const approvalsBudgetReached =
		nowMs() - startedAt >= options.budgetMs && !hasSyntheticApproveSlot;
	if (approvalsBudgetReached) {
		if (hasActorApprovalEvents) {
			options.notes.push(
				`Wallet-fast budget (${options.budgetMs}ms) reached before approval state reads; using event-derived approvals.`,
			);
			approvalsConfidence = minConfidence(approvalsConfidence, "medium");
		}
	} else if (hasApprovalSlots) {
		const previousBlock = receipt.blockNumber > 0n ? receipt.blockNumber - 1n : undefined;
		if (previousBlock === undefined) {
			options.notes.push(
				"Unable to read pre-transaction approvals for wallet-fast mode (missing previous block).",
			);
			approvalsConfidence = minConfidence(approvalsConfidence, "medium");
		} else {
			try {
				const diffResult = await buildApprovalDiffs(actorApprovals, options.client, {
					beforeBlock: previousBlock,
					afterBlock: receipt.blockNumber,
				});
				approvals = diffResult.approvals;
				approvalsConfidence = minConfidence(approvalsConfidence, diffResult.confidence);
				options.notes.push(...diffResult.notes);
			} catch (error) {
				const message = error instanceof Error ? error.message : "unknown error";
				options.notes.push(
					`Approval diff stage failed; using event-derived approvals (${message}).`,
				);
				approvalsConfidence = minConfidence(approvalsConfidence, "low");
			}
		}
	}
	options.timings?.add("simulation.walletFast.approvals", nowMs() - approvalsStarted);

	const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
	const nativeAfter = await options.client.getBalance({ address: options.from });
	const nativeDelta = nativeAfter - nativeBefore;
	const nativeDiff = nativeDelta + gasCost;

	const approvalTokenChanges: AssetChange[] = approvals
		.filter((approval) => approval.standard === "erc20" || approval.standard === "permit2")
		.map((approval) => ({
			assetType: "erc20",
			address: approval.token,
			direction: "in",
		}));

	const metadataSkipped = nowMs() - startedAt >= options.budgetMs;
	let metadata = new Map<Address, { symbol?: string; decimals?: number }>();
	if (!metadataSkipped) {
		const metadataStarted = nowMs();
		metadata = await readTokenMetadata(
			options.client,
			[...assetChanges, ...approvalTokenChanges],
			options.notes,
		);
		options.timings?.add("simulation.walletFast.metadata", nowMs() - metadataStarted);
	} else {
		options.notes.push(
			`Wallet-fast budget (${options.budgetMs}ms) reached; skipped ERC-20 metadata lookups.`,
		);
		balanceConfidence = minConfidence(balanceConfidence, "medium");
	}

	if (nowMs() - startedAt > options.budgetMs) {
		options.notes.push(`Wallet-fast simulation exceeded ${options.budgetMs}ms budget.`);
		balanceConfidence = minConfidence(balanceConfidence, "medium");
		if (hasActorApprovalEvents) {
			approvalsConfidence = minConfidence(approvalsConfidence, "medium");
		}
	}

	const enrichedChanges = applyTokenMetadata(assetChanges, metadata);
	const enrichedApprovals = applyApprovalMetadata(approvals, metadata);
	const adjustedConfidence = applyContractSenderConfidenceHeuristic({
		senderIsContract: options.senderIsContract === true,
		balanceConfidence,
		approvalsConfidence,
		balanceChanges: enrichedChanges,
		approvalChanges: enrichedApprovals,
		notes: options.notes,
	});

	return {
		success: true,
		gasUsed: receipt.gasUsed,
		effectiveGasPrice: receipt.effectiveGasPrice,
		nativeDiff,
		balances: {
			changes: enrichedChanges,
			confidence: adjustedConfidence.balanceConfidence,
		},
		approvals: {
			changes: enrichedApprovals,
			confidence: adjustedConfidence.approvalsConfidence,
		},
		notes: options.notes,
	};
}

async function checkContractAccountOnFork(client: AnvilClient, address: Address): Promise<boolean> {
	try {
		const code = await client.getCode({ address });
		return typeof code === "string" && code !== "0x";
	} catch {
		return false;
	}
}

function simulateFailure(
	message: string,
	notes: string[],
	balanceConfidence: SimulationConfidenceLevel,
	approvalsConfidence: SimulationConfidenceLevel,
	hints: string[] = [],
): BalanceSimulationResult {
	const mergedNotes = [...notes, message, ...hints];
	return {
		success: false,
		revertReason: message,
		balances: {
			changes: [],
			confidence: minConfidence(balanceConfidence, "low"),
		},
		approvals: {
			changes: [],
			confidence: minConfidence(approvalsConfidence, "low"),
		},
		notes: mergedNotes,
	};
}

function simulateHeuristic(
	tx: CalldataInput,
	chain: Chain,
	reason: string,
	hints: string[] = [],
): BalanceSimulationResult {
	const notes: string[] = [reason, "Heuristic-only simulation (no Anvil fork).", ...hints].filter(
		Boolean,
	);
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
		balances: {
			changes: assetChanges,
			confidence: "low",
		},
		approvals: {
			changes: approvals,
			confidence: "low",
		},
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

function isHexString(value: unknown): value is Hex {
	return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

function buildFailureHints(tx: CalldataInput): string[] {
	const hints: string[] = [];
	if (!tx.from) {
		hints.push("Hint: missing sender (`from`) address.");
	}
	if (!tx.to) {
		hints.push("Hint: missing target (`to`) address.");
	}
	if ((!tx.data || tx.data === "0x") && !isPlainEthTransfer(tx)) {
		hints.push("Hint: missing calldata (`data`).");
	}
	const value = parseValue(tx.value);
	if ((value === null || value === 0n) && transactionLooksLikeSwap(tx)) {
		hints.push("Hint: transaction value is 0; swaps often require non-zero ETH value.");
	}
	return hints;
}

function transactionLooksLikeSwap(tx: CalldataInput): boolean {
	if (!tx.data || tx.data === "0x") return false;
	const decoded = decodeKnownCalldata(tx.data);
	if (!decoded) return false;
	const functionName = decoded.functionName.toLowerCase();
	const signature = decoded.signature?.toLowerCase() ?? "";
	return (
		functionName.includes("swap") ||
		functionName.includes("exactinput") ||
		functionName.includes("exactoutput") ||
		signature.includes("swap")
	);
}

function toUserFacingSimulationFailure(message: string): string {
	if (/^Anvil exited with code/i.test(message)) {
		return "Local simulation backend was unavailable.";
	}
	if (/Timed out waiting for anvil RPC to start/i.test(message)) {
		return "Local simulation backend timed out.";
	}
	return message;
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
			const encoded = sliceHex(data, 4);
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
			const encoded = sliceHex(data, 4);
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
				.filter((address): address is Address => typeof address === "string" && isAddress(address)),
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

function applyApprovalMetadata(
	approvals: ApprovalChange[],
	metadata: Map<Address, { symbol?: string; decimals?: number }>,
): ApprovalChange[] {
	if (metadata.size === 0) return approvals;
	return approvals.map((approval) => {
		if (approval.standard !== "erc20" && approval.standard !== "permit2") return approval;
		if (!isAddress(approval.token)) return approval;
		const meta = metadata.get(approval.token);
		if (!meta) return approval;
		return {
			...approval,
			symbol: meta.symbol ?? approval.symbol,
			decimals: meta.decimals ?? approval.decimals,
		};
	});
}

function appendApproveCalldataSlotIfMissing(options: {
	approvals: ParsedApproval[];
	tx: CalldataInput;
	owner: Address;
	token: Address;
}): ParsedApproval[] {
	const inferred = inferApproveCalldataSlot(options.tx, options.owner, options.token);
	if (!inferred) return options.approvals;
	const hasMatch = options.approvals.some((approval) =>
		approvalTargetsSameSlot(approval, inferred),
	);
	if (hasMatch) return options.approvals;
	return [...options.approvals, inferred];
}

function inferApproveCalldataSlot(
	tx: CalldataInput,
	owner: Address,
	token: Address,
): ParsedApproval | null {
	if (!tx.data || tx.data === "0x") return null;
	const decoded = decodeKnownCalldata(tx.data);
	if (!decoded || decoded.standard !== "erc20" || decoded.functionName !== "approve") {
		return null;
	}
	if (!isRecord(decoded.args)) return null;
	const spender = decoded.args.spender;
	const amount = toBigInt(decoded.args.amount);
	if (typeof spender !== "string" || !isAddress(spender) || amount === null) {
		return null;
	}
	return {
		standard: "erc20",
		token,
		owner,
		spender,
		amount,
		scope: "token",
		logIndex: Number.MAX_SAFE_INTEGER,
	};
}

function approvalTargetsSameSlot(left: ParsedApproval, right: ParsedApproval): boolean {
	if (left.standard !== right.standard) return false;
	if (left.token.toLowerCase() !== right.token.toLowerCase()) return false;
	if (left.owner.toLowerCase() !== right.owner.toLowerCase()) return false;
	if (left.scope !== right.scope) return false;

	if (left.scope === "all" || right.scope === "all") {
		return left.spender.toLowerCase() === right.spender.toLowerCase();
	}

	if (left.standard === "erc721" && right.standard === "erc721") {
		if (left.tokenId !== undefined || right.tokenId !== undefined) {
			return left.tokenId === right.tokenId;
		}
	}

	return left.spender.toLowerCase() === right.spender.toLowerCase();
}

function applyContractSenderConfidenceHeuristic(options: {
	senderIsContract: boolean;
	balanceConfidence: SimulationConfidenceLevel;
	approvalsConfidence: SimulationConfidenceLevel;
	balanceChanges: AssetChange[];
	approvalChanges: ApprovalChange[];
	notes: string[];
}): {
	balanceConfidence: SimulationConfidenceLevel;
	approvalsConfidence: SimulationConfidenceLevel;
} {
	if (!options.senderIsContract) {
		return {
			balanceConfidence: options.balanceConfidence,
			approvalsConfidence: options.approvalsConfidence,
		};
	}

	const hasObservableDeltas =
		options.balanceChanges.length > 0 || options.approvalChanges.length > 0;
	if (hasObservableDeltas) {
		options.notes.push(
			"Contract sender had observable balance/approval deltas; confidence not downgraded.",
		);
		return {
			balanceConfidence: options.balanceConfidence,
			approvalsConfidence: options.approvalsConfidence,
		};
	}

	options.notes.push(
		"Contract sender produced no observable balance/approval deltas; confidence reduced.",
	);
	return {
		balanceConfidence: minConfidence(options.balanceConfidence, "low"),
		approvalsConfidence: minConfidence(options.approvalsConfidence, "low"),
	};
}

function filterApprovalsByOwner(approvals: ParsedApproval[], owner: Address): ParsedApproval[] {
	const ownerLower = owner.toLowerCase();
	return approvals.filter((approval) => approval.owner.toLowerCase() === ownerLower);
}

function mapParsedApprovalsToChanges(approvals: ParsedApproval[]): ApprovalChange[] {
	return approvals.map((approval) => ({
		standard: approval.standard,
		token: approval.token,
		owner: approval.owner,
		spender: approval.spender,
		amount: approval.amount,
		tokenId: approval.tokenId,
		scope: approval.scope,
		approved: approval.approved,
	}));
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

function minConfidence(
	current: SimulationConfidenceLevel,
	incoming: SimulationConfidenceLevel,
): SimulationConfidenceLevel {
	if (current === "none" || incoming === "none") return "none";
	if (current === "low" || incoming === "low") return "low";
	if (current === "medium" || incoming === "medium") return "medium";
	return "high";
}
