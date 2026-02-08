import { MAX_UINT256 } from "../../constants";
import * as sourcify from "../../providers/sourcify";
import type { CalldataInput } from "../../schema";
import type { Chain, Finding } from "../../types";
import type { DecodedCall } from "./decoder";
import { decodeAbiCalldata, decodeKnownCalldata, decodeSignatureCandidates } from "./decoder";
import { resolveSelector } from "./selector-resolver";
import { extractSelector, isRecord, toBigInt } from "./utils";

const MAX_SIGNATURE_DECODES = 5;
const MAX_SIGNATURE_DETAILS = 10;

export interface CalldataAnalysisResult {
	selector: string | null;
	findings: Finding[];
	decoded?: DecodedCall;
	decodedCandidates?: DecodedCall[];
}

export async function analyzeCalldata(
	input: CalldataInput,
	chain?: Chain,
	options?: { offline?: boolean },
): Promise<CalldataAnalysisResult> {
	const findings: Finding[] = [];
	const offline = options?.offline ?? false;
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
		return { selector, findings, decoded: known };
	}

	const abi = !offline && chain ? await sourcify.getABI(input.to, chain) : null;
	if (abi) {
		const decoded = decodeAbiCalldata(input.data, abi);
		if (decoded) {
			findings.push(buildDecodedFinding(decoded));
			return { selector, findings, decoded };
		}
	}

	const lookup = await resolveSelector(selector, { offline });
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
		return { selector, findings, decoded: primary, decodedCandidates: rest };
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
	const formattedCall = formatDecodedCall(primary);
	const details: Record<string, unknown> = {
		selector: primary.selector,
		signature: primary.signature,
		functionName: primary.functionName,
		source: primary.source,
		args: primary.args,
	};
	if (primary.argNames) {
		details.argNames = primary.argNames;
	}
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
		message: `Decoded calldata: ${formattedCall}`,
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

function formatDecodedCall(decoded: DecodedCall): string {
	const params = formatDecodedParams(decoded);
	return `${decoded.functionName}(${params})`;
}

function formatDecodedParams(decoded: DecodedCall): string {
	if (Array.isArray(decoded.args)) {
		const names = decoded.argNames;
		return decoded.args
			.map((value, index) => formatArgEntry(names?.[index], value, index))
			.join(", ");
	}
	if (isRecord(decoded.args)) {
		const names =
			decoded.argNames && decoded.argNames.length > 0
				? decoded.argNames
				: Object.keys(decoded.args);
		return names.map((name, index) => formatArgEntry(name, decoded.args[name], index)).join(", ");
	}
	return "";
}

function formatArgEntry(name: string | undefined, value: unknown, index: number): string {
	const label = name && name.length > 0 ? name : `arg${index}`;
	return `${label}: ${formatArgValue(value)}`;
}

function formatArgValue(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return value.toString();
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => formatArgValue(entry)).join(", ")}]`;
	}
	if (isRecord(value)) {
		const entries = Object.entries(value).map(([key, entry]) => `${key}: ${formatArgValue(entry)}`);
		return `{${entries.join(", ")}}`;
	}
	return String(value);
}
