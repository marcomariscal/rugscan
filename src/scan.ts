import { type AnalyzeOptions, analyze, determineRecommendation } from "./analyzer";
import { analyzeCalldata } from "./analyzers/calldata";
import { buildIntent } from "./intent";
import type {
	AnalyzeResponse,
	ContractInfo,
	BalanceSimulationResult as ScanBalanceSimulationResult,
	ScanFinding,
	ScanInput,
	ScanResult,
} from "./schema";
import { simulateBalance } from "./simulations/balance";
import { applySimulationVerdict, buildSimulationNotRun } from "./simulations/verdict";
import type {
	AnalysisResult,
	BalanceSimulationResult,
	Chain,
	Confidence,
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
	 * Advanced analyzer options (ex: provider budgets, wallet fast mode).
	 */
	analyzeOptions?: AnalyzeOptions;
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

	const analysis = await analyze(
		targetAddress,
		chain,
		options?.config,
		options?.progress,
		options?.analyzeOptions,
	);
	const mergedAnalysis = await mergeCalldataAnalysis(normalizedInput, analysis);
	const simulation = await runBalanceSimulation(
		normalizedInput,
		chain,
		options?.config,
		options?.progress,
	);
	const withSimulation = simulation ? { ...mergedAnalysis, simulation } : mergedAnalysis;
	const finalAnalysis = applySimulationVerdict(normalizedInput, withSimulation);
	const response = buildAnalyzeResponse(normalizedInput, finalAnalysis, options?.requestId);
	return { analysis: finalAnalysis, response };
}

async function mergeCalldataAnalysis(
	input: ScanInput,
	analysis: AnalysisResult,
): Promise<AnalysisResult> {
	if (!input.calldata) return analysis;
	const calldataAnalysis = await analyzeCalldata(input.calldata, analysis.contract.chain);
	const intent = calldataAnalysis.decoded
		? buildIntent(calldataAnalysis.decoded, {
				contractAddress: analysis.contract.address,
				contractName: analysis.contract.name,
			})
		: null;
	const hasFindings = calldataAnalysis.findings.length > 0;
	if (!hasFindings && !intent) return analysis;
	const findings = hasFindings
		? [...analysis.findings, ...calldataAnalysis.findings]
		: analysis.findings;
	return {
		...analysis,
		findings,
		recommendation: hasFindings ? determineRecommendation(findings) : analysis.recommendation,
		intent: intent ?? analysis.intent,
	};
}

export function buildAnalyzeResponse(
	input: ScanInput,
	analysis: AnalysisResult,
	requestId?: string,
): AnalyzeResponse {
	return {
		requestId: requestId ?? crypto.randomUUID(),
		scan: buildScanResult(input, analysis),
	};
}

export function buildScanResult(input: ScanInput, analysis: AnalysisResult): ScanResult {
	return {
		input,
		intent: analysis.intent,
		recommendation: analysis.recommendation,
		confidence: scoreConfidence(analysis.confidence),
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
		tags,
	};
}

async function runBalanceSimulation(
	input: ScanInput,
	chain: Chain,
	config: Config | undefined,
	progress: ScanProgress | undefined,
): Promise<BalanceSimulationResult | undefined> {
	if (!input.calldata) return undefined;

	progress?.({ provider: "Simulation", status: "start" });

	if (!shouldRunSimulation(config)) {
		progress?.({ provider: "Simulation", status: "success", message: "disabled" });
		return buildSimulationNotRun(input.calldata);
	}

	const result = await simulateBalance(input.calldata, chain, config);
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
	return {
		success: simulation.success,
		revertReason: simulation.revertReason,
		gasUsed: simulation.gasUsed?.toString(),
		effectiveGasPrice: simulation.effectiveGasPrice?.toString(),
		nativeDiff: simulation.nativeDiff?.toString(),
		assetChanges: simulation.assetChanges.map((change) => ({
			assetType: change.assetType,
			address: change.address,
			tokenId: change.tokenId?.toString(),
			amount: change.amount?.toString(),
			direction: change.direction,
			counterparty: change.counterparty,
			symbol: change.symbol,
			decimals: change.decimals,
		})),
		approvals: simulation.approvals.map((approval) => ({
			standard: approval.standard,
			token: approval.token,
			owner: approval.owner,
			spender: approval.spender,
			amount: approval.amount?.toString(),
			tokenId: approval.tokenId?.toString(),
			scope: approval.scope,
			approved: approval.approved,
			symbol: approval.symbol,
			decimals: approval.decimals,
		})),
		confidence: simulation.confidence,
		notes: simulation.notes,
	};
}

function scoreConfidence(confidence: Confidence): number {
	const base = confidence.level === "high" ? 0.9 : confidence.level === "medium" ? 0.6 : 0.3;
	const penalty = Math.min(confidence.reasons.length * 0.05, 0.2);
	return clamp(base - penalty, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}
