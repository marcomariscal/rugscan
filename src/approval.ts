import { analyze } from "./analyzer";
import { KNOWN_SPENDERS } from "./approvals/known-spenders";
import { isPossibleTyposquat } from "./approvals/typosquat";
import { MAX_UINT256 } from "./constants";
import * as proxy from "./providers/proxy";
import type {
	ApprovalAnalysisResult,
	ApprovalContext,
	ApprovalTx,
	Chain,
	Config,
	Finding,
	Recommendation,
} from "./types";

export async function analyzeApproval(
	tx: ApprovalTx,
	chain: Chain,
	context: ApprovalContext = {},
	config?: Config,
): Promise<ApprovalAnalysisResult> {
	const spender = tx.spender.toLowerCase();
	const expectedSpender = context.expectedSpender?.toLowerCase();
	const calledContract = context.calledContract?.toLowerCase();
	const rpcUrl = config?.rpcUrls?.[chain];

	const spenderIsContract = await proxy.isContract(spender, chain, rpcUrl);
	const spenderAnalysis = await analyze(spender, chain, config);

	const findings: Finding[] = [];
	const flags = {
		isUnlimited: false,
		targetMismatch: false,
		spenderUnverified: false,
		spenderNew: false,
		possibleTyposquat: false,
	};

	if (tx.amount === MAX_UINT256) {
		flags.isUnlimited = true;
		findings.push({
			level: "warning",
			code: "UNLIMITED_APPROVAL",
			message: "Unlimited token approval (max allowance)",
		});
	}

	if (hasTargetMismatch(spender, expectedSpender, calledContract)) {
		flags.targetMismatch = true;
		findings.push({
			level: "danger",
			code: "APPROVAL_TARGET_MISMATCH",
			message: buildMismatchMessage(spender, expectedSpender, calledContract),
		});
	}

	if (!spenderIsContract) {
		findings.push({
			level: "danger",
			code: "APPROVAL_TO_EOA",
			message: "Approval target is not a contract (EOA or empty)",
		});
	}

	if (spenderIsContract && !spenderAnalysis.contract.verified) {
		flags.spenderUnverified = true;
		findings.push({
			level: "warning",
			code: "APPROVAL_TO_UNVERIFIED",
			message: "Spender contract is not verified",
		});
	}

	if (spenderIsContract && spenderAnalysis.contract.age_days !== undefined) {
		if (spenderAnalysis.contract.age_days < 7) {
			flags.spenderNew = true;
			findings.push({
				level: "warning",
				code: "APPROVAL_TO_NEW_CONTRACT",
				message: `Spender contract deployed ${spenderAnalysis.contract.age_days} days ago`,
			});
		}
	}

	const typosquatMatch = isPossibleTyposquat(spender, KNOWN_SPENDERS[chain]);
	if (typosquatMatch) {
		flags.possibleTyposquat = true;
		findings.push({
			level: "danger",
			code: "POSSIBLE_TYPOSQUAT",
			message: `Spender address resembles ${typosquatMatch.match.name} (${typosquatMatch.match.address})`,
		});
	}

	const dangerFindings = spenderAnalysis.findings.filter((finding) => finding.level === "danger");
	if (dangerFindings.length > 0) {
		const codes = Array.from(new Set(dangerFindings.map((finding) => finding.code)));
		findings.push({
			level: "danger",
			code: "APPROVAL_TO_DANGEROUS_CONTRACT",
			message: `Spender contract has danger findings: ${codes.join(", ")}`,
		});
	}

	return {
		recommendation: determineApprovalRecommendation(findings),
		findings,
		spenderAnalysis,
		flags,
	};
}

function determineApprovalRecommendation(findings: Finding[]): Recommendation {
	const danger = findings.some((finding) => finding.level === "danger");
	if (danger) {
		return "danger";
	}
	const warningCount = findings.filter((finding) => finding.level === "warning").length;
	if (warningCount > 1) {
		return "caution";
	}
	if (warningCount === 1) {
		return "warning";
	}
	return "ok";
}

function hasTargetMismatch(
	spender: string,
	expectedSpender?: string,
	calledContract?: string,
): boolean {
	if (expectedSpender && expectedSpender !== spender) {
		return true;
	}
	if (!expectedSpender && calledContract && calledContract !== spender) {
		return true;
	}
	if (expectedSpender && calledContract && expectedSpender !== calledContract) {
		return true;
	}
	return false;
}

function buildMismatchMessage(
	spender: string,
	expectedSpender?: string,
	calledContract?: string,
): string {
	const details: string[] = [`spender ${spender}`];
	if (expectedSpender) {
		details.push(`expected ${expectedSpender}`);
	}
	if (calledContract) {
		details.push(`called ${calledContract}`);
	}
	return `Approval target mismatch (${details.join(", ")})`;
}
