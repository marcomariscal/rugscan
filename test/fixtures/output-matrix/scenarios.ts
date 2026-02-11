import type { PolicySummary } from "../../../src/cli/ui";
import { MAX_UINT256 } from "../../../src/constants";
import type { AnalysisResult } from "../../../src/types";

export interface OutputMatrixScenario {
	id: string;
	label: string;
	analysis: AnalysisResult;
	context: {
		hasCalldata: boolean;
		sender?: string;
		policy?: PolicySummary;
	};
	keyAssertions: string[];
}

const MALICIOUS_PHISHING_CONTRACT: OutputMatrixScenario = {
	id: "malicious-phishing-contract",
	label: "malicious phishing contract output",
	analysis: {
		contract: {
			address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			chain: "ethereum",
			name: "Permit2 Rewards Portal",
			verified: true,
			confidence: "high",
			is_proxy: false,
			age_days: 210,
			tx_count: 1204,
		},
		findings: [
			{
				level: "safe",
				code: "VERIFIED",
				message: "Source code verified: Permit2 Rewards Portal",
			},
			{
				level: "danger",
				code: "KNOWN_PHISHING",
				message: "Known phishing contract tied to wallet drain reports",
			},
			{
				level: "warning",
				code: "POSSIBLE_TYPOSQUAT",
				message: "Name resembles trusted Permit2 infrastructure",
			},
		],
		recommendation: "danger",
		intent: "Claim rewards",
	},
	context: {
		hasCalldata: false,
	},
	keyAssertions: [
		"Known phishing contract tied to wallet drain reports [KNOWN_PHISHING]",
		"👉 VERDICT: 🚨 DANGER",
		"BLOCK — high-risk findings detected.",
	],
};

const MALICIOUS_APPROVAL: OutputMatrixScenario = {
	id: "malicious-approval-drainer",
	label: "malicious approval output",
	analysis: {
		contract: {
			address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
			chain: "ethereum",
			name: "USD Coin",
			verified: true,
			confidence: "high",
			is_proxy: false,
		},
		protocol: "USDC",
		protocolMatch: {
			name: "USDC",
			slug: "usdc",
		},
		findings: [
			{
				level: "safe",
				code: "VERIFIED",
				message: "Source code verified: USD Coin",
			},
			{
				level: "safe",
				code: "KNOWN_PROTOCOL",
				message: "Recognized protocol: USDC",
			},
			{
				level: "danger",
				code: "APPROVAL_TO_DANGEROUS_CONTRACT",
				message: "Approval target is tied to known drainer activity",
			},
			{
				level: "warning",
				code: "UNLIMITED_APPROVAL",
				message: "Unlimited token approval (max allowance)",
			},
		],
		recommendation: "danger",
		intent: "Approve USDC allowance",
		simulation: {
			success: true,
			balances: {
				changes: [],
				confidence: "high",
			},
			approvals: {
				changes: [
					{
						standard: "erc20",
						token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
						owner: "0xfeed00000000000000000000000000000000beef",
						spender: "0x9999999999999999999999999999999999999999",
						amount: MAX_UINT256,
						previousAmount: 0n,
						scope: "token",
						symbol: "USDC",
						decimals: 6,
					},
				],
				confidence: "high",
			},
			notes: [],
		},
	},
	context: {
		hasCalldata: true,
		sender: "0xfeed00000000000000000000000000000000beef",
	},
	keyAssertions: [
		"Action: Allow 0x9999999999999999999999999999999999999999 to spend up to UNLIMITED USDC (0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48)",
		"🚨 Approval target is tied to known drainer activity [APPROVAL_TO_DANGEROUS_CONTRACT]",
		"⚠️ Allow 0x9999999999999999999999999999999999999999 to spend UNLIMITED USDC (0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48) (was 0)",
	],
};

const UNVERIFIED_CONTRACT: OutputMatrixScenario = {
	id: "unverified-contract",
	label: "unverified contract output",
	analysis: {
		contract: {
			address: "0x1111111111111111111111111111111111111111",
			chain: "base",
			name: "LaunchpadRouter",
			verified: false,
			confidence: "low",
			is_proxy: false,
			age_days: 0,
			tx_count: 3,
		},
		findings: [
			{
				level: "danger",
				code: "UNVERIFIED",
				message: "Source code is not verified",
			},
			{
				level: "info",
				code: "LOW_ACTIVITY",
				message: "Very low transaction history",
			},
		],
		recommendation: "warning",
		intent: "Contract review",
	},
	context: {
		hasCalldata: false,
	},
	keyAssertions: [
		"Context: unverified · age: 0d · txs: 3",
		"⚠️ Source not verified (or unknown)",
		"PROMPT + verify spender/recipient and approval scope before signing.",
	],
};

const WEIRD_INCONCLUSIVE_EDGE: OutputMatrixScenario = {
	id: "weird-inconclusive-edge",
	label: "weird/inconclusive edge output",
	analysis: {
		contract: {
			address: "0x2222222222222222222222222222222222222222",
			chain: "base",
			name: "MegaRouter",
			verified: true,
			confidence: "high",
			is_proxy: false,
		},
		findings: [
			{
				level: "safe",
				code: "VERIFIED",
				message: "Source code verified: MegaRouter",
			},
		],
		recommendation: "ok",
		intent: "swapAndBridge()",
		simulation: {
			success: false,
			revertReason: "execution reverted: custom error 0x4e487b71",
			nativeDiff: -5000000000000000n,
			balances: {
				changes: [
					{
						assetType: "erc20",
						address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
						direction: "out",
						amount: 50000000n,
						symbol: "USDC",
						decimals: 6,
					},
					{
						assetType: "erc20",
						address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
						direction: "in",
						amount: 49700000000000000000n,
						symbol: "DAI",
						decimals: 18,
					},
				],
				confidence: "low",
			},
			approvals: {
				changes: [],
				confidence: "low",
			},
			notes: [
				"Hint: wallet fast-mode enabled; trace fallback only.",
				"Hint: upstream RPC returned truncated trace results.",
			],
		},
	},
	context: {
		hasCalldata: true,
		sender: "0x3333333333333333333333333333333333333333",
	},
	keyAssertions: [
		"Simulation didn't complete (execution reverted: custom error 0x4e487b71)",
		"wallet fast-mode enabled; trace fallback only.",
		"⚠️ INCONCLUSIVE: simulation didn't complete (execution reverted: custom error 0x4e487b71); balance coverage incomplete; approval coverage incomplete",
		"BLOCK — simulation coverage incomplete",
	],
};

const HAPPY_PATH_SWAP: OutputMatrixScenario = {
	id: "happy-path-swap",
	label: "happy path swap",
	analysis: {
		contract: {
			address: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
			chain: "ethereum",
			name: "Universal Router",
			verified: true,
			confidence: "high",
			is_proxy: false,
		},
		protocol: "Uniswap",
		protocolMatch: {
			name: "Uniswap",
			slug: "uniswap",
		},
		findings: [
			{
				level: "safe",
				code: "VERIFIED",
				message: "Source code verified: Universal Router",
			},
			{
				level: "safe",
				code: "KNOWN_PROTOCOL",
				message: "Recognized protocol: Uniswap",
			},
		],
		recommendation: "ok",
		intent: "Swap ETH → USDC",
		simulation: {
			success: true,
			nativeDiff: -250000000000000000n,
			balances: {
				changes: [
					{
						assetType: "erc20",
						address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
						direction: "in",
						amount: 750000000n,
						symbol: "USDC",
						decimals: 6,
					},
				],
				confidence: "high",
			},
			approvals: {
				changes: [],
				confidence: "high",
			},
			notes: [],
		},
	},
	context: {
		hasCalldata: true,
		sender: "0x4444444444444444444444444444444444444444",
	},
	keyAssertions: [
		"Action: Swap 0.25 ETH → 750 USDC",
		"You sent 0.25 ETH",
		"You received 750 USDC",
		"SAFE to continue.",
	],
};

const INTRICATE_DEFI_ACTION: OutputMatrixScenario = {
	id: "intricate-defi-action",
	label: "intricate DeFi action",
	analysis: {
		contract: {
			address: "0x893411580e590d62ddbca8a703d61cc4a8c7b2b9",
			chain: "ethereum",
			proxy_name: "WrappedTokenGatewayV3",
			implementation_name: "WrappedTokenGatewayV3Impl",
			verified: true,
			confidence: "high",
			is_proxy: true,
			implementation: "0x31f3eb672c4f6f8e64f2af6f5919f6f63f8e0f8f",
		},
		protocol: "Aave V3",
		protocolMatch: {
			name: "Aave V3",
			slug: "aave-v3",
		},
		findings: [
			{
				level: "safe",
				code: "VERIFIED",
				message: "Source code verified: WrappedTokenGatewayV3",
			},
			{
				level: "safe",
				code: "KNOWN_PROTOCOL",
				message: "Recognized protocol: Aave V3",
			},
			{
				level: "warning",
				code: "UPGRADEABLE",
				message: "Upgradeable proxy (eip1967) - code can change",
			},
		],
		recommendation: "caution",
		intent: "Deposit collateral and borrow USDC",
		simulation: {
			success: true,
			nativeDiff: -1000000000000000000n,
			balances: {
				changes: [
					{
						assetType: "erc20",
						address: "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8",
						direction: "in",
						amount: 1000000000000000000n,
						symbol: "aWETH",
						decimals: 18,
					},
					{
						assetType: "erc20",
						address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
						direction: "in",
						amount: 1800000000n,
						symbol: "USDC",
						decimals: 6,
					},
				],
				confidence: "high",
			},
			approvals: {
				changes: [
					{
						standard: "erc20",
						token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
						owner: "0x5555555555555555555555555555555555555555",
						spender: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
						amount: 5000000000n,
						previousAmount: 1000000000n,
						scope: "token",
						symbol: "USDC",
						decimals: 6,
					},
					{
						standard: "erc20",
						token: "0x40d16fc0246a1f6811aebae6de4f4d3ef5f4377f",
						owner: "0x5555555555555555555555555555555555555555",
						spender: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
						amount: 0n,
						previousAmount: 250000000000000000000n,
						scope: "token",
						symbol: "GHO",
						decimals: 18,
					},
				],
				confidence: "high",
			},
			notes: [],
		},
	},
	context: {
		hasCalldata: true,
		sender: "0x5555555555555555555555555555555555555555",
	},
	keyAssertions: [
		"Contract: WrappedTokenGatewayV3 (0x893411580e590d62ddbca8a703d61cc4a8c7b2b9) → WrappedTokenGatewayV3Impl (0x31f3eb672c4f6f8e64f2af6f5919f6f63f8e0f8f)",
		"⚠️ Proxy / upgradeable (code can change)",
		"⚠️ Allow 0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2 to spend 5,000 USDC (0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48) (was 1,000)",
		"✓ Revoke 0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2 spending of GHO (0x40d16fc0246a1f6811aebae6de4f4d3ef5f4377f) (was 250)",
	],
};

export const OUTPUT_MATRIX_SCENARIOS: OutputMatrixScenario[] = [
	MALICIOUS_PHISHING_CONTRACT,
	MALICIOUS_APPROVAL,
	UNVERIFIED_CONTRACT,
	WEIRD_INCONCLUSIVE_EDGE,
	HAPPY_PATH_SWAP,
	INTRICATE_DEFI_ACTION,
];
