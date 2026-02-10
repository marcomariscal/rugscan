import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderHeading, renderResultBox } from "../src/cli/ui";
import type { AnalyzeResponse } from "../src/schema";
import type {
	AnalysisResult,
	BalanceSimulationResult,
	Chain,
	ConfidenceLevel,
	Finding,
	FindingLevel,
	Recommendation,
	SimulationConfidenceLevel,
} from "../src/types";

const recordingsDir = path.join(import.meta.dir, "fixtures", "recordings");

const BUNDLES = [
	"north-star__swap-sim-ok",
	"north-star__swap-sim-failed",
	"north-star__approve-unlimited-sim-not-run",
	"north-star__policy-unknown-spender",
] as const;

type PolicyEndpointRole = "to" | "recipient" | "spender" | "operator";

type PolicyDecision = "ALLOW" | "PROMPT" | "BLOCK";

type RenderContext = {
	hasCalldata?: boolean;
	sender?: string;
	policy?: {
		mode?: "wallet" | "cli";
		allowedProtocol?: { name: string; soft?: boolean };
		allowlisted?: Array<{ role: PolicyEndpointRole; address: string; label?: string }>;
		nonAllowlisted?: Array<{ role: PolicyEndpointRole; address: string; label?: string }>;
		decision?: PolicyDecision;
	};
};

function stripAnsi(input: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isChain(value: unknown): value is Chain {
	return (
		value === "ethereum" ||
		value === "base" ||
		value === "arbitrum" ||
		value === "optimism" ||
		value === "polygon"
	);
}

function isRecommendation(value: unknown): value is Recommendation {
	return value === "ok" || value === "caution" || value === "warning" || value === "danger";
}

function isFindingLevel(value: unknown): value is FindingLevel {
	return value === "danger" || value === "warning" || value === "info" || value === "safe";
}

function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
	return value === "high" || value === "medium" || value === "low";
}

function isSimulationConfidenceLevel(value: unknown): value is SimulationConfidenceLevel {
	return value === "high" || value === "medium" || value === "low" || value === "none";
}

function isFinding(value: unknown): value is Finding {
	if (!isRecord(value)) return false;
	if (!isFindingLevel(value.level)) return false;
	if (typeof value.code !== "string" || value.code.length === 0) return false;
	if (typeof value.message !== "string" || value.message.length === 0) return false;
	if ("details" in value && value.details !== undefined && !isRecord(value.details)) return false;
	if ("refs" in value && value.refs !== undefined && !Array.isArray(value.refs)) return false;
	return true;
}

function isBalanceSimulationResult(value: unknown): value is BalanceSimulationResult {
	if (!isRecord(value)) return false;
	if (typeof value.success !== "boolean") return false;
	if (!isRecord(value.balances)) return false;
	if (!Array.isArray(value.balances.changes)) return false;
	if (!isSimulationConfidenceLevel(value.balances.confidence)) return false;
	if (!isRecord(value.approvals)) return false;
	if (!Array.isArray(value.approvals.changes)) return false;
	if (!isSimulationConfidenceLevel(value.approvals.confidence)) return false;
	if (!Array.isArray(value.notes)) return false;
	if (
		"revertReason" in value &&
		value.revertReason !== undefined &&
		typeof value.revertReason !== "string"
	) {
		return false;
	}
	return true;
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
	if (!isRecord(value)) return false;
	if (!isRecord(value.contract)) return false;
	if (typeof value.contract.address !== "string" || value.contract.address.length === 0)
		return false;
	if (!isChain(value.contract.chain)) return false;
	if (typeof value.contract.verified !== "boolean") return false;
	if (!isConfidenceLevel(value.contract.confidence)) return false;
	if (typeof value.contract.is_proxy !== "boolean") return false;

	if (!Array.isArray(value.findings) || !value.findings.every(isFinding)) return false;
	if (!isRecommendation(value.recommendation)) return false;
	if ("intent" in value && value.intent !== undefined && typeof value.intent !== "string")
		return false;
	if ("protocol" in value && value.protocol !== undefined && typeof value.protocol !== "string")
		return false;
	if ("simulation" in value && value.simulation !== undefined && value.simulation !== null) {
		if (!isBalanceSimulationResult(value.simulation)) return false;
	}
	return true;
}

function isPolicyEndpointRole(value: unknown): value is PolicyEndpointRole {
	return value === "to" || value === "recipient" || value === "spender" || value === "operator";
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
	return value === "ALLOW" || value === "PROMPT" || value === "BLOCK";
}

function isPolicyEndpoint(value: unknown): value is {
	role: PolicyEndpointRole;
	address: string;
	label?: string;
} {
	if (!isRecord(value)) return false;
	if (!isPolicyEndpointRole(value.role)) return false;
	if (typeof value.address !== "string" || value.address.length === 0) return false;
	if ("label" in value && value.label !== undefined && typeof value.label !== "string")
		return false;
	return true;
}

function isPolicySummary(value: unknown): value is NonNullable<RenderContext["policy"]> {
	if (!isRecord(value)) return false;
	if (
		"mode" in value &&
		value.mode !== undefined &&
		value.mode !== "wallet" &&
		value.mode !== "cli"
	) {
		return false;
	}
	if ("decision" in value && value.decision !== undefined && !isPolicyDecision(value.decision)) {
		return false;
	}
	if ("allowedProtocol" in value && value.allowedProtocol !== undefined) {
		if (!isRecord(value.allowedProtocol)) return false;
		if (typeof value.allowedProtocol.name !== "string" || value.allowedProtocol.name.length === 0) {
			return false;
		}
		if (
			"soft" in value.allowedProtocol &&
			value.allowedProtocol.soft !== undefined &&
			typeof value.allowedProtocol.soft !== "boolean"
		) {
			return false;
		}
	}
	if ("allowlisted" in value && value.allowlisted !== undefined) {
		if (!Array.isArray(value.allowlisted) || !value.allowlisted.every(isPolicyEndpoint))
			return false;
	}
	if ("nonAllowlisted" in value && value.nonAllowlisted !== undefined) {
		if (!Array.isArray(value.nonAllowlisted) || !value.nonAllowlisted.every(isPolicyEndpoint)) {
			return false;
		}
	}
	return true;
}

function isRenderContext(value: unknown): value is RenderContext {
	if (!isRecord(value)) return false;
	if (
		"hasCalldata" in value &&
		value.hasCalldata !== undefined &&
		typeof value.hasCalldata !== "boolean"
	) {
		return false;
	}
	if ("sender" in value && value.sender !== undefined && typeof value.sender !== "string") {
		return false;
	}
	if ("policy" in value && value.policy !== undefined && !isPolicySummary(value.policy)) {
		return false;
	}
	return true;
}

function isAnalyzeResponse(value: unknown): value is AnalyzeResponse {
	if (!isRecord(value)) return false;
	if (value.schemaVersion !== 2) return false;
	if (typeof value.requestId !== "string") return false;
	if (!isRecord(value.scan)) return false;
	return true;
}

describe("north-star pre-sign UX (contract)", () => {
	test("recording bundles render required headings + deterministic inconclusive semantics", async () => {
		for (const bundle of BUNDLES) {
			const dir = path.join(recordingsDir, bundle);
			const analysisRaw = JSON.parse(await readFile(path.join(dir, "analysis.json"), "utf-8"));
			const contextRaw = JSON.parse(await readFile(path.join(dir, "context.json"), "utf-8"));
			const responseRaw = JSON.parse(
				await readFile(path.join(dir, "analyzeResponse.json"), "utf-8"),
			);
			const expectedRaw = await readFile(path.join(dir, "rendered.txt"), "utf-8");

			expect(isAnalysisResult(analysisRaw)).toBe(true);
			expect(isRenderContext(contextRaw)).toBe(true);
			expect(isAnalyzeResponse(responseRaw)).toBe(true);
			if (!isAnalysisResult(analysisRaw) || !isRenderContext(contextRaw)) {
				throw new Error(`Invalid fixtures in ${bundle}`);
			}

			const analysis = analysisRaw;
			const context = contextRaw;

			const scanLabel = context.hasCalldata ? "Transaction" : "Address";
			const actual = `${renderHeading(`${scanLabel} scan on ${analysis.contract.chain}`)}\n\n${renderResultBox(analysis, context)}\n`;
			const normalizedActual = stripAnsi(actual);
			const normalizedExpected = stripAnsi(expectedRaw);

			// 1) Lock the output (fixtures are golden recordings)
			expect(normalizedActual).toBe(normalizedExpected);

			// 2) Determine if this is a clean assessment (compact) or degraded (full detail)
			const hasActionableFindings = analysis.findings.some(
				(f: { code: string; level: string }) =>
					f.level !== "safe" &&
					f.code !== "CALLDATA_DECODED" &&
					f.code !== "CALLDATA_UNKNOWN_SELECTOR" &&
					f.code !== "CALLDATA_SIGNATURES" &&
					f.code !== "CALLDATA_EMPTY" &&
					f.code !== "VERIFIED" &&
					f.code !== "KNOWN_PROTOCOL",
			);
			const simulationUncertain =
				Boolean(context.hasCalldata) &&
				(!analysis.simulation ||
					!analysis.simulation.success ||
					analysis.simulation.balances.confidence !== "high" ||
					analysis.simulation.approvals.confidence !== "high");
			const isClean =
				analysis.recommendation === "ok" && !simulationUncertain && !hasActionableFindings;

			if (isClean) {
				// Compact: no RECOMMENDATION, no CHECKS — just verdict
				expect(normalizedActual).not.toContain("🎯 RECOMMENDATION");
				expect(normalizedActual).not.toContain("🧾 CHECKS");
				expect(normalizedActual).toContain("✅");
			} else {
				// Degraded: full headings in order
				const requiredHeadings = [
					"🎯 RECOMMENDATION",
					"🧾 CHECKS",
					...(context.hasCalldata ? ["💰 BALANCE CHANGES", "🔐 APPROVALS"] : []),
					"👉 VERDICT",
				];
				let lastIndex = -1;
				for (const heading of requiredHeadings) {
					expect(normalizedActual).toContain(heading);
					const index = normalizedActual.indexOf(heading);
					expect(index).toBeGreaterThan(lastIndex);
					lastIndex = index;
				}

				// CHECKS includes compact metadata context
				expect(normalizedActual).toContain("Context:");
				expect(normalizedActual).toContain("age:");
				expect(normalizedActual).toContain("txs:");
			}

			// 3) Optional policy section (only when configured AND degraded)
			if (!isClean && context.policy) {
				const checksIndex = normalizedActual.indexOf("🧾 CHECKS");
				const balanceIndex = normalizedActual.indexOf("💰 BALANCE CHANGES");
				const policyIndex = normalizedActual.indexOf("🛡️ POLICY / ALLOWLIST");
				expect(policyIndex).toBeGreaterThan(checksIndex);
				if (balanceIndex >= 0) {
					expect(policyIndex).toBeLessThan(balanceIndex);
				}
			}

			// 4) INCONCLUSIVE semantics (simulation uncertain => explicit line)
			if (simulationUncertain) {
				expect(normalizedActual).toContain("INCONCLUSIVE");
			} else {
				expect(normalizedActual).not.toContain("INCONCLUSIVE");
			}

			// 5) Policy decision semantics
			if (context.policy) {
				if (simulationUncertain) {
					expect(normalizedActual).toContain("Policy decision: BLOCK (INCONCLUSIVE simulation)");
				}
				if (!simulationUncertain && (context.policy.nonAllowlisted?.length ?? 0) > 0) {
					expect(normalizedActual).toContain("Non-allowlisted");
					expect(normalizedActual).toContain("Policy decision: BLOCK");
				}
			}
		}
	});
});
