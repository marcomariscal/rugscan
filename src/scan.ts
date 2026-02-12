import { type AnalyzeOptions, analyze, determineRecommendation } from "./analyzer";
import { analyzeCalldata } from "./analyzers/calldata";
import { buildPlainEthTransferIntent } from "./calldata/plain-transfer";
import { buildIntent } from "./intent";
import {
	type AnalyzeResponse,
	ASSAY_SCHEMA_VERSION,
	type CalldataInput,
	type ContractInfo,
	type BalanceSimulationResult as ScanBalanceSimulationResult,
	type ScanFinding,
	type ScanInput,
	type ScanResult,
} from "./schema";
import { simulateBalance } from "./simulations/balance";
import { applySimulationVerdict, buildSimulationNotRun } from "./simulations/verdict";
import type { TimingStore } from "./timing";
import type {
	AnalysisResult,
	BalanceSimulationResult,
	Chain,
	Config,
	Finding,
	FindingLevel,
} from "./types";

export type ScanProgress = (event: {
	provider: string;
	status: "start" | "success" | "error";
	message?: string;
}) => void;

export interface ScanOptions {
	chain?: string;
	config?: Config;
	requestId?: string;
	progress?: ScanProgress;
	/**
	 * Strict offline mode: only the configured upstream JSON-RPC URL is allowed.
	 */
	offline?: boolean;
	/**
	 * Advanced analyzer options (ex: provider budgets, wallet fast mode).
	 */
	analyzeOptions?: AnalyzeOptions;
	timings?: TimingStore;
}

const CHAIN_NAME_LOOKUP: Record<string, Chain> = {
	ethereum: "ethereum",
	base: "base",
	arbitrum: "arbitrum",
	optimism: "optimism",
	polygon: "polygon",
};

const CHAIN_ID_LOOKUP: Record<string, Chain> = {
	"1": "ethereum",
	"8453": "base",
	"42161": "arbitrum",
	"10": "optimism",
	"137": "polygon",
};

const DEFAULT_CHAIN: Chain = "ethereum";

export function resolveScanChain(value?: string): Chain | null {
	if (!value) return DEFAULT_CHAIN;
	const normalized = value.toLowerCase();
	const byName = CHAIN_NAME_LOOKUP[normalized];
	if (byName) return byName;
	const byId = CHAIN_ID_LOOKUP[normalized];
	if (byId) return byId;
	return null;
}

export async function scan(input: ScanInput, options?: ScanOptions): Promise<AnalyzeResponse> {
	const result = await scanWithAnalysis(input, options);
	return result.response;
}

export async function scanWithAnalysis(
	input: ScanInput,
	options?: ScanOptions,
): Promise<{ analysis: AnalysisResult; response: AnalyzeResponse }> {
	const normalizedInput = normalizeInput(input);
	const chain = resolveScanChain(resolveChainSource(input, options?.chain));
	if (!chain) {
		throw new Error("Invalid chain");
	}
	const targetAddress = normalizedInput.address ?? normalizedInput.calldata?.to;
	if (!targetAddress) {
		throw new Error("Missing scan input");
	}

	const analyzeOptions = options?.offline
		? { ...(options?.analyzeOptions ?? {}), offline: true }
		: options?.analyzeOptions;

	const analysis = await analyze(
		targetAddress,
		chain,
		options?.config,
		options?.progress,
		analyzeOptions,
	);
	const mergedAnalysis = await mergeCalldataAnalysis(normalizedInput, analysis, {
		offline: options?.offline,
	});
	const simulation = await runBalanceSimulation(
		normalizedInput,
		chain,
		options?.config,
		options?.progress,
		options?.timings,
		{ offline: options?.offline, mode: analyzeOptions?.mode },
	);
	const finalAnalysis = applySimulationVerdict(normalizedInput, { ...mergedAnalysis, simulation });
	const response = buildAnalyzeResponse(normalizedInput, finalAnalysis, options?.requestId);
	return { analysis: finalAnalysis, response };
}

async function mergeCalldataAnalysis(
	input: ScanInput,
	analysis: AnalysisResult,
	options?: { offline?: boolean },
): Promise<AnalysisResult> {
	if (!input.calldata) return analysis;
	const calldataAnalysis = await analyzeCalldata(input.calldata, analysis.contract.chain, {
		offline: options?.offline,
	});
	const intent = calldataAnalysis.decoded
		? buildIntent(calldataAnalysis.decoded, {
				contractAddress: analysis.contract.address,
				contractName: analysis.contract.name,
			})
		: null;
	const plainTransferIntent = buildPlainEthTransferIntent(input.calldata);
	const eip7702Findings = buildEip7702Findings(input.calldata);
	const hasFindings = calldataAnalysis.findings.length > 0 || eip7702Findings.length > 0;
	if (!hasFindings && !intent && !plainTransferIntent) return analysis;
	const findings = hasFindings
		? [...analysis.findings, ...calldataAnalysis.findings, ...eip7702Findings]
		: analysis.findings;
	return {
		...analysis,
		findings,
		recommendation: hasFindings ? determineRecommendation(findings) : analysis.recommendation,
		protocol: plainTransferIntent ? "ETH Transfer" : analysis.protocol,
		intent: plainTransferIntent ?? intent ?? analysis.intent,
	};
}

/**
 * Generate findings for EIP-7702 (type-4) transactions with authorization lists.
 *
 * Authorization lists delegate the sender's EOA to contract code, which is a
 * significant security surface. Each delegate address is surfaced as a finding
 * so the user can make an informed decision.
 */
function buildEip7702Findings(calldata: CalldataInput): Finding[] {
	const authList = calldata.authorizationList;
	if (!authList || authList.length === 0) return [];

	const findings: Finding[] = [];
	const delegates = authList.map((entry) => entry.address);

	findings.push({
		level: "warning",
		code: "EIP7702_AUTHORIZATION",
		message: `EIP-7702 transaction delegates sender EOA to ${delegates.length} contract(s): ${delegates.join(", ")}. The sender's account will temporarily execute code from these addresses.`,
		details: {
			delegateCount: delegates.length,
			delegates: authList.map((entry) => ({
				address: entry.address,
				chainId: entry.chainId,
				nonce: entry.nonce,
			})),
		},
	});

	return findings;
}

export function buildAnalyzeResponse(
	input: ScanInput,
	analysis: AnalysisResult,
	requestId?: string,
): AnalyzeResponse {
	return {
		schemaVersion: ASSAY_SCHEMA_VERSION,
		requestId: requestId ?? crypto.randomUUID(),
		scan: buildScanResult(input, analysis),
	};
}

export function buildScanResult(input: ScanInput, analysis: AnalysisResult): ScanResult {
	return {
		input,
		intent: analysis.intent,
		recommendation: analysis.recommendation,
		findings: mapFindings(analysis.findings),
		contract: buildContractInfo(analysis),
		simulation: analysis.simulation ? mapSimulation(analysis.simulation) : undefined,
	};
}

function normalizeInput(input: ScanInput): ScanInput {
	if (input.address) {
		return { address: input.address.toLowerCase() };
	}
	if (input.calldata) {
		return {
			calldata: {
				...input.calldata,
				from: input.calldata.from ? input.calldata.from.toLowerCase() : undefined,
				to: input.calldata.to.toLowerCase(),
			},
		};
	}
	return {};
}

function resolveChainSource(input: ScanInput, chainOverride?: string): string | undefined {
	if (input.calldata?.chain) {
		return input.calldata.chain;
	}
	return chainOverride;
}

function mapFindings(findings: Finding[]): ScanFinding[] {
	return findings.map((finding) => ({
		code: finding.code,
		severity: mapFindingLevel(finding.level),
		message: finding.message,
		details: finding.details,
		refs: finding.refs,
	}));
}

function mapFindingLevel(level: FindingLevel): ScanFinding["severity"] {
	if (level === "danger") return "danger";
	if (level === "warning") return "warning";
	if (level === "info") return "caution";
	return "ok";
}

function buildContractInfo(analysis: AnalysisResult): ContractInfo {
	const hasNotContractFinding = analysis.findings.some(
		(finding) =>
			finding.code === "LOW_ACTIVITY" && finding.message.toLowerCase().includes("not a contract"),
	);
	const tags = analysis.protocol ? [analysis.protocol] : undefined;
	return {
		address: analysis.contract.address,
		chain: analysis.contract.chain,
		isContract: !hasNotContractFinding,
		name: analysis.contract.name,
		isProxy: analysis.contract.is_proxy,
		implementation: analysis.contract.implementation,
		verifiedSource: analysis.contract.verified,
		confidence: analysis.contract.confidence,
		tags,
	};
}

async function runBalanceSimulation(
	input: ScanInput,
	chain: Chain,
	config: Config | undefined,
	progress: ScanProgress | undefined,
	timings: TimingStore | undefined,
	options?: { offline?: boolean; mode?: "default" | "wallet" },
): Promise<BalanceSimulationResult> {
	if (!input.calldata) {
		return buildSimulationNotRun(undefined);
	}

	progress?.({ provider: "Simulation", status: "start" });

	if (!shouldRunSimulation(config)) {
		progress?.({ provider: "Simulation", status: "success", message: "disabled" });
		return buildSimulationNotRun(input.calldata);
	}

	const result = await simulateBalance(input.calldata, chain, config, timings, {
		offline: options?.offline,
		mode: options?.mode,
	});
	progress?.({
		provider: "Simulation",
		status: result.success ? "success" : "error",
		message: result.success ? "ok" : (result.revertReason ?? "failed"),
	});
	return result;
}

function shouldRunSimulation(config?: Config): boolean {
	const simulation = config?.simulation;
	// Zero-config default: attempt simulation on calldata scans unless explicitly disabled.
	// If Anvil is unavailable, the simulation layer will report "not run" with hints.
	if (!simulation) return true;
	if (simulation.enabled === undefined) return true;
	return simulation.enabled;
}

function mapSimulation(simulation: BalanceSimulationResult): ScanBalanceSimulationResult {
	const status = simulation.success
		? "success"
		: simulation.balances.confidence === "none" && simulation.approvals.confidence === "none"
			? "not_run"
			: "failed";

	return {
		status,
		revertReason: simulation.revertReason,
		gasUsed: simulation.gasUsed?.toString(),
		effectiveGasPrice: simulation.effectiveGasPrice?.toString(),
		nativeDiff: simulation.nativeDiff?.toString(),
		balances: {
			changes: simulation.balances.changes.map((change) => ({
				assetType: change.assetType,
				address: change.address,
				tokenId: change.tokenId?.toString(),
				amount: change.amount?.toString(),
				direction: change.direction,
				counterparty: change.counterparty,
				symbol: change.symbol,
				decimals: change.decimals,
			})),
			confidence: simulation.balances.confidence,
		},
		approvals: {
			changes: simulation.approvals.changes.map((approval) => ({
				standard: approval.standard,
				token: approval.token,
				owner: approval.owner,
				spender: approval.spender,
				amount: approval.amount?.toString(),
				previousAmount: approval.previousAmount?.toString(),
				tokenId: approval.tokenId?.toString(),
				scope: approval.scope,
				approved: approval.approved,
				previousApproved: approval.previousApproved,
				previousSpender: approval.previousSpender,
				symbol: approval.symbol,
				decimals: approval.decimals,
			})),
			confidence: simulation.approvals.confidence,
		},
		notes: simulation.notes,
	};
}
