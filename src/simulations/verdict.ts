import type { ScanInput } from "../schema";
import type { AnalysisResult, BalanceSimulationResult } from "../types";

export function applySimulationVerdict(input: ScanInput, analysis: AnalysisResult): AnalysisResult {
	if (!input.calldata) return analysis;
	const simulation = analysis.simulation;
	if (simulation && simulation.success) return analysis;
	const recommendation = ensureCaution(analysis.recommendation);
	return {
		...analysis,
		recommendation,
	};
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
