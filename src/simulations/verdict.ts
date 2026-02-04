import { determineRecommendation } from "../analyzer";
import { KNOWN_SPENDERS } from "../approvals/known-spenders";
import type { ScanInput } from "../schema";
import type { AnalysisResult, BalanceSimulationResult, Finding } from "../types";

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;

export function applySimulationVerdict(input: ScanInput, analysis: AnalysisResult): AnalysisResult {
	if (!input.calldata) return analysis;
	const simulation = analysis.simulation;
	if (simulation?.success) {
		return applySimulationDrainerHeuristics(input, analysis, simulation);
	}
	const recommendation = ensureCaution(analysis.recommendation);
	return {
		...analysis,
		recommendation,
	};
}

function applySimulationDrainerHeuristics(
	input: ScanInput,
	analysis: AnalysisResult,
	simulation: BalanceSimulationResult,
): AnalysisResult {
	const chain = analysis.contract.chain;
	const knownSpenders = new Set(
		(KNOWN_SPENDERS[chain] ?? []).map((spender) => spender.address.toLowerCase()),
	);
	const findings: Finding[] = [...analysis.findings];
	const originalCount = findings.length;

	const unlimitedApprovals = simulation.approvals.filter((approval) => {
		if (approval.standard !== "erc20" && approval.standard !== "permit2") return false;
		if (approval.amount === undefined) return false;
		const isUnlimited =
			approval.standard === "permit2"
				? approval.amount === MAX_UINT160
				: approval.amount === MAX_UINT256;
		if (!isUnlimited) return false;
		if (isKnownSpender(knownSpenders, approval.spender)) return false;
		return true;
	});

	if (unlimitedApprovals.length > 0) {
		findings.push({
			level: "warning",
			code: "SIM_UNLIMITED_APPROVAL_UNKNOWN_SPENDER",
			message: "Simulation shows an unlimited ERC-20 approval to an unknown spender",
			details: {
				spenders: uniqueLowercased(unlimitedApprovals.map((a) => a.spender)),
				tokens: uniqueLowercased(unlimitedApprovals.map((a) => a.token)),
			},
		});
	}

	const approvalForAll = simulation.approvals.filter((approval) => {
		if (approval.standard !== "erc721" && approval.standard !== "erc1155") return false;
		if (approval.scope !== "all") return false;
		if (approval.approved !== true) return false;
		if (isKnownSpender(knownSpenders, approval.spender)) return false;
		return true;
	});

	if (approvalForAll.length > 0) {
		findings.push({
			level: "danger",
			code: "SIM_APPROVAL_FOR_ALL_UNKNOWN_OPERATOR",
			message: "Simulation shows an ApprovalForAll granted to an unknown operator",
			details: {
				operators: uniqueLowercased(approvalForAll.map((a) => a.spender)),
				tokens: uniqueLowercased(approvalForAll.map((a) => a.token)),
			},
		});
	}

	const outgoingChanges = simulation.assetChanges.filter((change) => change.direction === "out");
	const outgoingCounterparties = uniqueLowercased(
		outgoingChanges
			.map((change) => change.counterparty)
			.filter((value): value is string => typeof value === "string" && value.length > 0),
	);
	const unknownOutgoingCounterparties = outgoingCounterparties.filter((counterparty) => {
		if (isKnownSpender(knownSpenders, counterparty)) return false;
		const calldataTo = input.calldata?.to;
		if (calldataTo && counterparty === calldataTo.toLowerCase()) return false;
		return true;
	});

	if (unknownOutgoingCounterparties.length >= 2 || outgoingChanges.length >= 3) {
		findings.push({
			level: unknownOutgoingCounterparties.length >= 2 ? "danger" : "warning",
			code: "SIM_MULTIPLE_OUTBOUND_TRANSFERS",
			message: "Simulation shows multiple outbound asset transfers",
			details: {
				outboundChanges: outgoingChanges.length,
				counterparties: outgoingCounterparties,
				unknownCounterparties: unknownOutgoingCounterparties,
			},
		});
	}

	if (findings.length === originalCount) return analysis;
	return {
		...analysis,
		findings,
		recommendation: determineRecommendation(findings),
	};
}

function isKnownSpender(knownSpenders: Set<string>, spender: string): boolean {
	return knownSpenders.has(spender.toLowerCase());
}

function uniqueLowercased(values: string[]): string[] {
	const set = new Set<string>();
	for (const value of values) {
		set.add(value.toLowerCase());
	}
	return [...set];
}

export function buildSimulationNotRun(input: ScanInput["calldata"]): BalanceSimulationResult {
	if (!input) {
		return {
			success: false,
			revertReason: "Simulation not run",
			assetChanges: [],
			approvals: [],
			confidence: "low",
			notes: ["Simulation not run"],
		};
	}
	const notes: string[] = ["Simulation not run"];
	if (!input.from) {
		notes.push("Hint: missing sender (`from`) address.");
	}
	if (!input.to) {
		notes.push("Hint: missing target (`to`) address.");
	}
	if (!input.data || input.data === "0x") {
		notes.push("Hint: missing calldata (`data`).");
	}
	const value = parseNumericValue(input.value);
	if (value === null || value === 0n) {
		notes.push("Hint: transaction value is 0; swaps often require non-zero ETH value.");
	}
	return {
		success: false,
		revertReason: "Simulation not run",
		assetChanges: [],
		approvals: [],
		confidence: "low",
		notes,
	};
}

function ensureCaution(
	recommendation: AnalysisResult["recommendation"],
): AnalysisResult["recommendation"] {
	const order: AnalysisResult["recommendation"][] = ["ok", "caution", "warning", "danger"];
	const currentIndex = order.indexOf(recommendation);
	const cautionIndex = order.indexOf("caution");
	if (currentIndex === -1) return "caution";
	return currentIndex < cautionIndex ? "caution" : recommendation;
}

function parseNumericValue(value?: string): bigint | null {
	if (!value) return null;
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}
