import { analyze, determineRecommendation } from "./analyzer";
import { analyzeCalldata } from "./analyzers/calldata";
import type { AnalysisResult, Chain, Confidence, Config, Finding, FindingLevel } from "./types";
import type { AnalyzeResponse, ContractInfo, ScanFinding, ScanInput, ScanResult } from "./schema";

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

	const analysis = await analyze(targetAddress, chain, options?.config, options?.progress);
	const mergedAnalysis = await mergeCalldataAnalysis(normalizedInput, analysis);
	const response = buildAnalyzeResponse(normalizedInput, mergedAnalysis, options?.requestId);
	return { analysis: mergedAnalysis, response };
}

async function mergeCalldataAnalysis(
	input: ScanInput,
	analysis: AnalysisResult,
): Promise<AnalysisResult> {
	if (!input.calldata) return analysis;
	const calldataAnalysis = await analyzeCalldata(input.calldata);
	if (calldataAnalysis.findings.length === 0) return analysis;
	const findings = [...analysis.findings, ...calldataAnalysis.findings];
	return {
		...analysis,
		findings,
		recommendation: determineRecommendation(findings),
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
		recommendation: analysis.recommendation,
		confidence: scoreConfidence(analysis.confidence),
		findings: mapFindings(analysis.findings),
		contract: buildContractInfo(analysis),
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
	const hasNotContractFinding = analysis.findings.some((finding) =>
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
