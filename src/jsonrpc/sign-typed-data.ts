import type { Recommendation } from "../types";

const RECOMMENDATION_ORDER: Recommendation[] = ["ok", "caution", "warning", "danger"];
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const LONG_EXPIRY_SECONDS = 30n * 24n * 60n * 60n;

export interface TypedDataField {
	name: string;
	type: string;
}

export interface TypedDataPayload {
	types: Record<string, TypedDataField[]>;
	primaryType?: string;
	domain: Record<string, unknown>;
	message: Record<string, unknown>;
}

export interface SignTypedDataV4Payload {
	account?: string;
	typedData: TypedDataPayload;
}

export interface TypedDataRiskFinding {
	code: string;
	severity: Recommendation;
	message: string;
	details?: Record<string, unknown>;
}

export interface TypedDataRiskAssessment {
	recommendation: Recommendation;
	permitLike: boolean;
	primaryType?: string;
	chainId?: string;
	spender?: string;
	token?: string;
	amount?: string;
	deadline?: string;
	findings: TypedDataRiskFinding[];
	actionableNotes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parseNumeric(value: unknown): bigint | null {
	if (typeof value === "bigint") return value;
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
		return BigInt(value);
	}
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
			return BigInt(trimmed);
		}
		if (/^[0-9]+$/.test(trimmed)) {
			return BigInt(trimmed);
		}
		return null;
	} catch {
		return null;
	}
}

function parseChainId(value: unknown): string | undefined {
	const parsed = parseNumeric(value);
	if (parsed === null) return undefined;
	return parsed.toString();
}

function parseTypes(value: unknown): Record<string, TypedDataField[]> | null {
	if (!isRecord(value)) return null;
	const parsed: Record<string, TypedDataField[]> = {};
	for (const [key, fieldList] of Object.entries(value)) {
		if (!Array.isArray(fieldList)) continue;
		const fields: TypedDataField[] = [];
		for (const item of fieldList) {
			if (!isRecord(item)) continue;
			if (typeof item.name !== "string" || typeof item.type !== "string") continue;
			fields.push({ name: item.name, type: item.type });
		}
		parsed[key] = fields;
	}
	return parsed;
}

function parseTypedDataPayload(value: unknown): TypedDataPayload | null {
	if (!isRecord(value)) return null;
	if (!isRecord(value.domain) || !isRecord(value.message)) return null;
	const types = parseTypes(value.types);
	if (!types) return null;
	const primaryType = typeof value.primaryType === "string" ? value.primaryType : undefined;
	return {
		types,
		primaryType,
		domain: value.domain,
		message: value.message,
	};
}

export function extractSignTypedDataV4Payload(params: unknown): SignTypedDataV4Payload | null {
	if (!Array.isArray(params) || params.length < 2) return null;

	const account =
		typeof params[0] === "string" && isAddress(params[0]) ? params[0].toLowerCase() : undefined;

	const rawPayload =
		typeof params[1] === "string"
			? (() => {
					try {
						return JSON.parse(params[1]);
					} catch {
						return null;
					}
				})()
			: params[1];

	const typedData = parseTypedDataPayload(rawPayload);
	if (!typedData) return null;
	return { account, typedData };
}

function findFirstValueByKeys(
	value: unknown,
	keys: Set<string>,
	predicate: (candidate: unknown) => boolean,
	depth = 0,
): unknown {
	if (depth > 8) return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findFirstValueByKeys(item, keys, predicate, depth + 1);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (!isRecord(value)) return undefined;

	for (const [key, candidate] of Object.entries(value)) {
		if (keys.has(key.toLowerCase()) && predicate(candidate)) {
			return candidate;
		}
	}
	for (const candidate of Object.values(value)) {
		const found = findFirstValueByKeys(candidate, keys, predicate, depth + 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

function findFirstAddressByKeys(value: unknown, keys: string[]): string | undefined {
	const keySet = new Set(keys.map((key) => key.toLowerCase()));
	const found = findFirstValueByKeys(
		value,
		keySet,
		(candidate) => typeof candidate === "string" && isAddress(candidate),
	);
	return typeof found === "string" ? found.toLowerCase() : undefined;
}

function findFirstNumericByKeys(value: unknown, keys: string[]): bigint | null {
	const keySet = new Set(keys.map((key) => key.toLowerCase()));
	const found = findFirstValueByKeys(
		value,
		keySet,
		(candidate) => parseNumeric(candidate) !== null,
	);
	return found === undefined ? null : parseNumeric(found);
}

function findFirstBooleanByKeys(value: unknown, keys: string[]): boolean | null {
	const keySet = new Set(keys.map((key) => key.toLowerCase()));
	const found = findFirstValueByKeys(value, keySet, (candidate) => typeof candidate === "boolean");
	return typeof found === "boolean" ? found : null;
}

function resolvePrimaryType(payload: TypedDataPayload): string | undefined {
	if (payload.primaryType) return payload.primaryType;
	for (const typeName of Object.keys(payload.types)) {
		if (typeName === "EIP712Domain") continue;
		return typeName;
	}
	return undefined;
}

function hasPermitLikeShape(payload: TypedDataPayload, primaryType?: string): boolean {
	const typeNames = Object.keys(payload.types).map((name) => name.toLowerCase());
	if (typeNames.some((name) => name.includes("permit"))) return true;
	if (primaryType?.toLowerCase().includes("permit")) return true;

	if (!primaryType) return false;
	const fields = payload.types[primaryType];
	if (!fields) return false;
	const fieldNames = new Set(fields.map((field) => field.name.toLowerCase()));
	const hasSpenderField = fieldNames.has("spender") || fieldNames.has("operator");
	const hasAllowanceField =
		fieldNames.has("value") ||
		fieldNames.has("amount") ||
		fieldNames.has("allowed") ||
		fieldNames.has("details") ||
		fieldNames.has("permitted");
	return hasSpenderField && hasAllowanceField;
}

function recommendationAtLeast(actual: Recommendation, threshold: Recommendation): boolean {
	const actualIndex = RECOMMENDATION_ORDER.indexOf(actual);
	const thresholdIndex = RECOMMENDATION_ORDER.indexOf(threshold);
	if (actualIndex === -1 || thresholdIndex === -1) return true;
	return actualIndex >= thresholdIndex;
}

function ensureRecommendationAtLeast(
	actual: Recommendation,
	minimum: Recommendation,
): Recommendation {
	return recommendationAtLeast(actual, minimum) ? actual : minimum;
}

export function analyzeSignTypedDataV4Risk(
	payload: SignTypedDataV4Payload,
	options?: { nowUnix?: bigint },
): TypedDataRiskAssessment {
	const primaryType = resolvePrimaryType(payload.typedData);
	const permitLike = hasPermitLikeShape(payload.typedData, primaryType);
	const chainId = parseChainId(payload.typedData.domain.chainId);

	if (!permitLike) {
		return {
			recommendation: "ok",
			permitLike: false,
			primaryType,
			chainId,
			findings: [],
			actionableNotes: [],
		};
	}

	const spender = findFirstAddressByKeys(payload.typedData.message, ["spender", "operator"]);
	const token = findFirstAddressByKeys(payload.typedData.message, ["token", "tokenAddress"]);
	const amount = findFirstNumericByKeys(payload.typedData.message, ["value", "amount"]);
	const allowed = findFirstBooleanByKeys(payload.typedData.message, ["allowed"]);
	const deadline = findFirstNumericByKeys(payload.typedData.message, [
		"sigDeadline",
		"deadline",
		"expiry",
		"expiration",
	]);

	let recommendation: Recommendation = "caution";
	const findings: TypedDataRiskFinding[] = [];
	const actionableNotes: string[] = [];

	findings.push({
		code: "PERMIT_SIGNATURE",
		severity: "caution",
		message:
			"Permit-style signature detected: this can grant off-chain token spending authority without an on-chain approval transaction.",
		details: {
			method: "eth_signTypedData_v4",
			primaryType,
			spender,
			token,
			amount: amount?.toString(),
			deadline: deadline?.toString(),
			allowed,
			account: payload.account,
			chainId,
		},
	});

	if (spender) {
		actionableNotes.push(`Spender authority: ${spender}`);
	} else {
		recommendation = ensureRecommendationAtLeast(recommendation, "warning");
		actionableNotes.push(
			"Could not parse spender/operator address; verify every typed-data field before signing.",
		);
	}

	if (token) {
		actionableNotes.push(`Token in signed payload: ${token}`);
	}

	const hasUnlimitedAmount = allowed === true || amount === MAX_UINT160 || amount === MAX_UINT256;
	if (hasUnlimitedAmount) {
		recommendation = ensureRecommendationAtLeast(recommendation, "warning");
		findings.push({
			code: "PERMIT_UNLIMITED_ALLOWANCE",
			severity: "warning",
			message:
				"Signed permit appears to grant unlimited allowance (max uint160/uint256 or allowed=true).",
			details: {
				amount: amount?.toString(),
				allowed,
			},
		});
		actionableNotes.push(
			"Allowance scope appears unlimited — signing can enable full token drain by the spender.",
		);
	} else if (amount !== null) {
		actionableNotes.push(`Allowance amount: ${amount.toString()}`);
	}

	if (deadline === null) {
		recommendation = ensureRecommendationAtLeast(recommendation, "warning");
		findings.push({
			code: "PERMIT_NO_EXPIRY",
			severity: "warning",
			message:
				"No signature expiry field was found in typed data. Treat this as high risk unless you fully trust the spender.",
		});
		actionableNotes.push(
			"No expiry detected; signed authority may remain valid longer than expected.",
		);
	} else if (deadline === 0n) {
		recommendation = ensureRecommendationAtLeast(recommendation, "warning");
		findings.push({
			code: "PERMIT_ZERO_EXPIRY",
			severity: "warning",
			message: "Permit deadline/expiry is 0, which is commonly used as no-expiry authority.",
			details: { deadline: "0" },
		});
		actionableNotes.push(
			"Expiry value is 0 (effectively no expiry in many permit implementations).",
		);
	} else {
		const nowUnix = options?.nowUnix ?? BigInt(Math.floor(Date.now() / 1000));
		if (deadline > nowUnix + LONG_EXPIRY_SECONDS) {
			recommendation = ensureRecommendationAtLeast(recommendation, "warning");
			findings.push({
				code: "PERMIT_LONG_EXPIRY",
				severity: "warning",
				message: "Permit expiry is far in the future (>30 days), increasing replay/drain window.",
				details: { deadline: deadline.toString() },
			});
			actionableNotes.push(`Expiry is long-lived (unix ${deadline.toString()}).`);
		} else {
			actionableNotes.push(`Expiry (unix): ${deadline.toString()}`);
		}
	}

	actionableNotes.push("Only sign if you trust the spender, token, amount, and expiry settings.");

	return {
		recommendation,
		permitLike,
		primaryType,
		chainId,
		spender,
		token,
		amount: amount?.toString(),
		deadline: deadline?.toString(),
		findings,
		actionableNotes,
	};
}
