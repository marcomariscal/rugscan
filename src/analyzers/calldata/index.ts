import { MAX_UINT256 } from "../../constants";
import type { CalldataInput } from "../../schema";
import type { Finding } from "../../types";
import type { DecodedCall } from "./decoder";
import { decodeKnownCalldata, decodeSignatureCandidates } from "./decoder";
import { resolveSelector } from "./selector-resolver";
import { extractSelector, isRecord, toBigInt } from "./utils";

const MAX_SIGNATURE_DECODES = 5;
const MAX_SIGNATURE_DETAILS = 10;

export interface CalldataAnalysisResult {
	selector: string | null;
	findings: Finding[];
}

export async function analyzeCalldata(input: CalldataInput): Promise<CalldataAnalysisResult> {
	const findings: Finding[] = [];
	const selector = extractSelector(input.data);
	if (!selector) {
		findings.push({
			level: "info",
			code: "CALLDATA_EMPTY",
			message: "Calldata missing function selector",
			details: {
				dataLength: input.data.length,
			},
		});
		return { selector: null, findings };
	}

	const known = decodeKnownCalldata(input.data);
	if (known) {
		findings.push(buildDecodedFinding(known));
		const unlimited = buildUnlimitedApprovalFinding(known);
		if (unlimited) {
			findings.push(unlimited);
		}
		return { selector, findings };
	}

	const lookup = await resolveSelector(selector);
	if (lookup.signatures.length === 0) {
		findings.push({
			level: "info",
			code: "CALLDATA_UNKNOWN_SELECTOR",
			message: `Unknown function selector ${selector}`,
			details: { selector },
		});
		return { selector, findings };
	}

	const candidates = decodeSignatureCandidates(
		input.data,
		lookup.signatures.slice(0, MAX_SIGNATURE_DECODES),
	);
	if (candidates.length > 0) {
		const [primary, ...rest] = candidates;
		findings.push(buildDecodedFinding(primary, rest));
		return { selector, findings };
	}

	findings.push({
		level: "info",
		code: "CALLDATA_SIGNATURES",
		message: buildSignatureMessage(selector, lookup.signatures.length),
		details: buildSignatureDetails(selector, lookup.signatures),
	});
	return { selector, findings };
}

function buildDecodedFinding(primary: DecodedCall, alternatives: DecodedCall[] = []): Finding {
	const details: Record<string, unknown> = {
		selector: primary.selector,
		signature: primary.signature,
		functionName: primary.functionName,
		source: primary.source,
		args: primary.args,
	};
	if (primary.standard) {
		details.standard = primary.standard;
	}
	if (primary.argTypes) {
		details.argTypes = primary.argTypes;
	}
	if (alternatives.length > 0) {
		details.candidates = alternatives.map((candidate) => ({
			signature: candidate.signature,
			functionName: candidate.functionName,
			args: candidate.args,
			argTypes: candidate.argTypes,
		}));
	}
	return {
		level: "info",
		code: "CALLDATA_DECODED",
		message: `Decoded calldata: ${primary.signature}`,
		details,
	};
}

function buildUnlimitedApprovalFinding(decoded: DecodedCall): Finding | null {
	if (!decoded.standard) return null;
	if (!isRecord(decoded.args)) return null;

	if (decoded.standard === "erc20" && decoded.functionName === "approve") {
		const amount = toBigInt(decoded.args.amount);
		if (amount === null || amount !== MAX_UINT256) return null;
		return {
			level: "warning",
			code: "UNLIMITED_APPROVAL",
			message: "Unlimited token approval (max allowance)",
			details: {
				method: "approve",
				spender: decoded.args.spender,
				amount: decoded.args.amount,
			},
		};
	}

	if (decoded.standard === "eip2612" && decoded.functionName === "permit") {
		const value = toBigInt(decoded.args.value);
		if (value === null || value !== MAX_UINT256) return null;
		return {
			level: "warning",
			code: "UNLIMITED_APPROVAL",
			message: "Unlimited token approval (max allowance)",
			details: {
				method: "permit",
				spender: decoded.args.spender,
				value: decoded.args.value,
			},
		};
	}

	return null;
}

function buildSignatureMessage(selector: string, count: number): string {
	const plural = count === 1 ? "signature" : "signatures";
	return `Selector ${selector} matches ${count} ${plural}`;
}

function buildSignatureDetails(selector: string, signatures: string[]): Record<string, unknown> {
	const details: Record<string, unknown> = { selector, signatureCount: signatures.length };
	if (signatures.length > 0) {
		details.signatures = signatures.slice(0, MAX_SIGNATURE_DETAILS);
		if (signatures.length > MAX_SIGNATURE_DETAILS) {
			details.truncated = true;
		}
	}
	return details;
}
