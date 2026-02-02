export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function extractSelector(data: string): string | null {
	if (!data.startsWith("0x")) return null;
	if (data.length < 10) return null;
	return data.slice(0, 10).toLowerCase();
}

export function isAddress(value: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function normalizeAddress(value: string): string {
	return isAddress(value) ? value.toLowerCase() : value;
}

export function toBigInt(value: unknown): bigint | null {
	if (typeof value === "bigint") return value;
	if (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value)) {
		return BigInt(value);
	}
	if (typeof value === "string") {
		if (/^0x[0-9a-fA-F]+$/.test(value)) {
			return BigInt(value);
		}
		if (/^[0-9]+$/.test(value)) {
			return BigInt(value);
		}
	}
	return null;
}

export function stringifyValue(value: unknown): unknown {
	if (value === null) return null;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => stringifyValue(entry));
	}
	if (isRecord(value)) {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = stringifyValue(entry);
		}
		return result;
	}
	return null;
}
