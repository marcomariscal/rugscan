import { formatNativeWei } from "../format/amounts";

function parseValue(value?: string): bigint | null {
	if (!value) return null;
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

export function isEmptyCalldata(data?: string): boolean {
	return !data || data === "0x";
}

export function isPlainEthTransfer(input: { data?: string; value?: string } | undefined): boolean {
	if (!input || !isEmptyCalldata(input.data)) return false;
	const value = parseValue(input.value);
	return value !== null && value > 0n;
}

export function buildPlainEthTransferIntent(input: {
	to?: string;
	data?: string;
	value?: string;
}): string | null {
	if (!input.to) return null;
	if (!isPlainEthTransfer({ data: input.data, value: input.value })) return null;
	const amountLabel = formatNativeWei(input.value, 4);
	if (!amountLabel) return null;
	return `Send ${amountLabel} ETH to ${input.to.toLowerCase()}`;
}
