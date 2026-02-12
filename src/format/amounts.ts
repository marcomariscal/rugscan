import { toBigInt } from "../analyzers/calldata/utils";

function formatInteger(value: bigint): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function formatRoundedFixed(value: bigint, decimals: number, maxFractionDigits: number): string {
	if (decimals <= 0 || maxFractionDigits <= 0) {
		if (decimals <= 0) {
			return formatInteger(value);
		}
		const roundingFactor = 10n ** BigInt(decimals);
		const rounded = (value + roundingFactor / 2n) / roundingFactor;
		return formatInteger(rounded);
	}

	const effectiveFractionDigits = Math.min(decimals, maxFractionDigits);
	let scaled = value;
	if (decimals > effectiveFractionDigits) {
		const roundingFactor = 10n ** BigInt(decimals - effectiveFractionDigits);
		scaled = (value + roundingFactor / 2n) / roundingFactor;
	}

	if (effectiveFractionDigits === 0) {
		return formatInteger(scaled);
	}

	const raw = scaled.toString().padStart(effectiveFractionDigits + 1, "0");
	const splitIndex = raw.length - effectiveFractionDigits;
	const integerPart = raw.slice(0, splitIndex);
	const fractionPart = raw.slice(splitIndex).replace(/0+$/g, "");
	const formattedInteger = formatInteger(BigInt(integerPart));
	if (fractionPart.length === 0) {
		return formattedInteger;
	}
	return `${formattedInteger}.${fractionPart}`;
}

export function formatAmountWithDecimals(
	value: unknown,
	decimals: number,
	maxFractionDigits: number,
): string | null {
	const amount = toBigInt(value);
	if (amount === null) return null;
	if (amount < 0n) {
		const formatted = formatRoundedFixed(-amount, decimals, maxFractionDigits);
		return `-${formatted}`;
	}
	return formatRoundedFixed(amount, decimals, maxFractionDigits);
}

export function formatNativeWei(value: unknown, maxFractionDigits = 4): string | null {
	return formatAmountWithDecimals(value, 18, maxFractionDigits);
}
