import type { AbiEvent } from "viem";
import type { Chain } from "./types";

// Uniswap Permit2 (AllowanceTransfer) contract.
// Docs/interface source: https://github.com/Uniswap/permit2
export const PERMIT2_CANONICAL_ADDRESS = "0x000000000022d473030f116ddee9f6b43ac78ba3";

export const PERMIT2_ADDRESS: Record<Chain, string> = {
	ethereum: PERMIT2_CANONICAL_ADDRESS,
	base: PERMIT2_CANONICAL_ADDRESS,
	arbitrum: PERMIT2_CANONICAL_ADDRESS,
	optimism: PERMIT2_CANONICAL_ADDRESS,
	polygon: PERMIT2_CANONICAL_ADDRESS,
};

export const PERMIT2_APPROVAL_EVENT: AbiEvent = {
	anonymous: false,
	type: "event",
	name: "Approval",
	inputs: [
		{ indexed: true, name: "owner", type: "address" },
		{ indexed: true, name: "token", type: "address" },
		{ indexed: true, name: "spender", type: "address" },
		{ indexed: false, name: "amount", type: "uint160" },
		{ indexed: false, name: "expiration", type: "uint48" },
	],
};

export const PERMIT2_PERMIT_EVENT: AbiEvent = {
	anonymous: false,
	type: "event",
	name: "Permit",
	inputs: [
		{ indexed: true, name: "owner", type: "address" },
		{ indexed: true, name: "token", type: "address" },
		{ indexed: true, name: "spender", type: "address" },
		{ indexed: false, name: "amount", type: "uint160" },
		{ indexed: false, name: "expiration", type: "uint48" },
		{ indexed: false, name: "nonce", type: "uint48" },
	],
};
