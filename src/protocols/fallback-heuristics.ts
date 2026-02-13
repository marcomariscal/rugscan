import { KNOWN_SPENDERS } from "../approvals/known-spenders";
import type { Chain, ProtocolMatch } from "../types";
import { matchTopProtocolAddress } from "./top-protocol-registry";

interface ProtocolNameHint {
	match: {
		name: string;
		slug: string;
	};
	hints: readonly string[];
}

const HIGH_CONFIDENCE_NAME_HINTS: readonly ProtocolNameHint[] = [
	{
		match: { name: "Uniswap", slug: "uniswap" },
		hints: ["uniswap", "permit2"],
	},
	{
		match: { name: "Aave", slug: "aave" },
		hints: ["aave"],
	},
	{
		match: { name: "Curve", slug: "curve" },
		hints: ["curve"],
	},
	{
		match: { name: "1inch", slug: "1inch-network" },
		hints: ["1inch", "aggregationrouter"],
	},
	{
		match: { name: "QuickSwap", slug: "quickswap-dex" },
		hints: ["quickswap"],
	},
	{
		match: { name: "SushiSwap", slug: "sushiswap" },
		hints: ["sushiswap"],
	},
	{
		match: { name: "Balancer", slug: "balancer-v2" },
		hints: ["balancer"],
	},
	{
		match: { name: "CoW Protocol", slug: "cow-protocol" },
		hints: ["cow", "gpv2"],
	},
	{
		match: { name: "0x Protocol", slug: "0x-protocol" },
		hints: ["zeroex"],
	},
	{
		match: { name: "Morpho", slug: "morpho-blue" },
		hints: ["morpho"],
	},
	{
		match: { name: "OpenSea Seaport", slug: "opensea-seaport" },
		hints: ["seaport"],
	},
	{
		match: { name: "Lido", slug: "lido" },
		hints: ["lido"],
	},
	{
		match: { name: "Compound", slug: "compound-finance" },
		hints: ["compound"],
	},
	{
		match: { name: "Cap", slug: "cap" },
		hints: ["capv1", "capproxy"],
	},
	{
		match: { name: "ether.fi", slug: "ether-fi" },
		hints: ["etherfi", "weeth"],
	},
];

export function inferProtocolFallback(input: {
	address: string;
	chain: Chain;
	implementationName?: string;
	proxyName?: string;
}): ProtocolMatch | null {
	const manualMatch = matchTopProtocolAddress(input.address, input.chain);
	if (manualMatch) {
		return manualMatch;
	}

	const fromSpender = inferProtocolFromKnownSpenderName(input.address, input.chain);
	if (fromSpender) {
		return fromSpender;
	}

	const fromImplementationName = inferProtocolFromName(input.implementationName);
	if (fromImplementationName) {
		return fromImplementationName;
	}

	return inferProtocolFromName(input.proxyName);
}

export function inferProtocolFromKnownSpenderName(
	address: string,
	chain: Chain,
): ProtocolMatch | null {
	const knownSpender = (KNOWN_SPENDERS[chain] ?? []).find(
		(entry) => entry.address.toLowerCase() === address.toLowerCase(),
	);
	if (!knownSpender) {
		return null;
	}
	return inferProtocolFromName(knownSpender.name);
}

function inferProtocolFromName(value: string | undefined): ProtocolMatch | null {
	if (!value) {
		return null;
	}
	const normalized = normalizeName(value);
	if (!normalized) {
		return null;
	}

	for (const entry of HIGH_CONFIDENCE_NAME_HINTS) {
		if (entry.hints.some((hint) => normalized.includes(hint))) {
			return { ...entry.match };
		}
	}

	return null;
}

function normalizeName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
