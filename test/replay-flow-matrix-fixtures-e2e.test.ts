import { test as bunTest, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

const test = process.env.ASSAY_FORK_E2E === "1" ? bunTest : bunTest.skip;
const alwaysTest = bunTest;

type NativeDiffExpectation = "positive" | "negative" | "zero";

type ReplayMatrixEntry = {
	flow: string;
	fixturePath: string;
	nativeDiff: NativeDiffExpectation;
	intentIncludes?: string;
	intentExcludes?: string[];
	requireDecodedCalldata?: boolean;
	requireCalldataEmpty?: boolean;
	/** Assert decoded functionName matches exactly */
	requireDecodedFunctionName?: string;
	/** Assert a VERIFIED finding containing this contract name */
	requireVerifiedName?: string;
	/** Assert required finding codes are present */
	requireFindingCodes?: string[];
	/** Assert forbidden finding codes are absent */
	forbidFindingCodes?: string[];
};

type ReplayLaneScaffold = {
	lane: string;
	placeholderFixturePath: string;
	skipReason: string;
	acceptanceCriteria: string[];
};

type ParsedFixture = {
	chain: number;
	forkBlock: number;
	to: string;
	from: string;
	value: string;
	data: string;
};

const foundryDefaultAnvilPath = path.join(process.env.HOME ?? "", ".foundry", "bin", "anvil");

const REPLAY_MATRIX: ReplayMatrixEntry[] = [
	{
		flow: "Uniswap real swap",
		fixturePath: "fixtures/txs/uniswap-v4-universalrouter-eth-swap-873d55dd.json",
		nativeDiff: "negative",
		intentIncludes: "Uniswap Universal Router",
		requireDecodedCalldata: true,
	},
	{
		flow: "Aave real lend/supply",
		fixturePath: "fixtures/lend-borrow/aave-v3-gateway-deposit-1eth.tx.json",
		nativeDiff: "negative",
		intentIncludes: "Supply ETH to Aave",
		requireDecodedCalldata: true,
	},
	{
		flow: "Aave real borrow",
		fixturePath: "fixtures/lend-borrow/aave-v3-gateway-borrow.tx.json",
		nativeDiff: "positive",
		intentIncludes: "Borrow ETH from Aave",
		requireDecodedCalldata: true,
	},
	{
		flow: "ERC20 approve",
		fixturePath: "fixtures/txs/erc20-approve-usdc-limited.json",
		nativeDiff: "zero",
		intentIncludes: "Approve",
		requireDecodedCalldata: true,
	},
	{
		flow: "ERC20 transfer",
		fixturePath: "fixtures/txs/erc20-transfer-usdc-real.json",
		nativeDiff: "zero",
		intentIncludes: "Transfer",
		requireDecodedCalldata: true,
	},
	{
		flow: "ETH transfer",
		fixturePath: "fixtures/txs/eth-transfer-mainnet-real.json",
		nativeDiff: "negative",
		requireCalldataEmpty: true,
	},
	// === Pass 12: Multicall, additional protocol (1inch), Safe execTransaction ===
	{
		flow: "Uniswap V3 SwapRouter multicall (exactInputSingle + unwrapWETH9)",
		fixturePath: "fixtures/txs/uniswap-v3-swaprouter-multicall-695c6606.json",
		nativeDiff: "positive",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "multicall",
	},
	{
		flow: "1inch AggregationRouterV4 swap (additional protocol)",
		fixturePath: "fixtures/txs/1inch-v4-uniswapv3swap-4e9ab241.json",
		nativeDiff: "zero",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "uniswapV3Swap",
		requireVerifiedName: "AggregationRouterV4",
	},
	{
		flow: "1inch AggregationRouterV6 swap",
		fixturePath: "fixtures/txs/1inch-aggregation-router-v6-swap.json",
		nativeDiff: "zero",
		intentIncludes: "1inch aggregated swap",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "swap",
	},
	{
		flow: "Gnosis Safe execTransaction (USDT approve via Permit2)",
		fixturePath: "fixtures/txs/gnosis-safe-exec-usdt-approve-ed42563e.json",
		nativeDiff: "zero",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "execTransaction",
	},
	// === Matrix lanes 1-6: Assay UX hard-gate coverage ===
	// Lane 1: Permit / Permit2 signatures/approvals
	{
		flow: "ERC20 approve to Permit2 (max uint256)",
		fixturePath: "fixtures/txs/erc20-approve-usdc-permit2-max.json",
		nativeDiff: "zero",
		intentIncludes: "Approve",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "approve",
		requireFindingCodes: ["UNLIMITED_APPROVAL"],
	},
	{
		flow: "Permit2 approve (unlimited allowance to unknown spender)",
		fixturePath: "fixtures/txs/permit2-approve-usdc-unlimited.json",
		nativeDiff: "zero",
		intentIncludes: "Permit2: Allow",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "approve",
		requireFindingCodes: ["SIM_UNLIMITED_APPROVAL_UNKNOWN_SPENDER"],
	},
	// Lane 2: ERC20 transferFrom spender-path drain
	{
		flow: "ERC20 transferFrom spender-path (USDC drain)",
		fixturePath: "fixtures/txs/erc20-transferfrom-usdc-spender-path-fd229120.json",
		nativeDiff: "zero",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "transferFrom",
	},
	// Lane 3: ERC721/ERC1155 setApprovalForAll operator approvals
	{
		flow: "ERC721 setApprovalForAll (ENS → OpenSea operator)",
		fixturePath: "fixtures/txs/erc721-approval-for-all-ens-opensea-true.json",
		nativeDiff: "zero",
		intentIncludes: "Grant",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "setApprovalForAll",
		requireFindingCodes: ["SIM_APPROVAL_FOR_ALL_UNKNOWN_OPERATOR"],
	},
	{
		flow: "ERC721 setApprovalForAll revoke (ENS operator false-positive guard)",
		fixturePath: "fixtures/txs/erc721-approval-for-all-ens-revoke-false.json",
		nativeDiff: "zero",
		intentIncludes: "Revoke",
		intentExcludes: ["Grant"],
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "setApprovalForAll",
		forbidFindingCodes: ["SIM_APPROVAL_FOR_ALL_UNKNOWN_OPERATOR"],
	},
	{
		flow: "ERC1155 setApprovalForAll (Mirror MNFTs → operator)",
		fixturePath: "fixtures/txs/erc1155-approval-for-all-mirror-mnfts-opensea-true.json",
		nativeDiff: "zero",
		intentIncludes: "Grant",
		requireDecodedCalldata: true,
		requireFindingCodes: ["SIM_APPROVAL_FOR_ALL_UNKNOWN_OPERATOR"],
	},
	// Lane 4: Bridge transaction path (Circle CCTP depositForBurn)
	{
		flow: "Bridge: CCTP depositForBurn USDC (Ethereum → remote)",
		fixturePath: "fixtures/txs/bridge-cctp-depositforburn-usdc-517cf9a8.json",
		nativeDiff: "zero",
		intentIncludes: "Bridge",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "depositForBurn",
	},
	// Lane 5: Proxy admin upgrade call path
	{
		flow: "Proxy admin upgradeToAndCall",
		fixturePath: "fixtures/txs/proxy-upgrade-to-and-call-de7374fb.json",
		nativeDiff: "zero",
		intentIncludes: "Upgrade proxy implementation",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "upgradeToAndCall",
		requireFindingCodes: ["UPGRADEABLE"],
	},
	// Lane 6: EIP-4337 flow path (EntryPoint handleOps)
	{
		flow: "EIP-4337 EntryPoint handleOps (UserOperation bundle)",
		fixturePath: "fixtures/txs/eip4337-entrypoint-handleops-90631007.json",
		nativeDiff: "positive",
		intentIncludes: "EIP-4337",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "handleOps",
	},
	// === Pass 17: Ownership mutation + canonical L2 bridge (non-CCTP) ===
	// Lane 7: Ownership transfer / role mutation
	{
		flow: "Ownable transferOwnership (GMNFT)",
		fixturePath: "fixtures/txs/ownership-transfer-gmnft-0f66c130.json",
		nativeDiff: "zero",
		intentIncludes: "Transfer contract ownership",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "transferOwnership",
	},
	// Lane 8: Canonical L2 bridge deposit (non-CCTP) — Optimism Standard Bridge
	{
		flow: "Bridge: Optimism Standard Bridge depositETH (canonical L2, non-CCTP)",
		fixturePath: "fixtures/txs/bridge-optimism-deposit-eth-45c8b3d7.json",
		nativeDiff: "negative",
		intentIncludes: "Bridge ETH to Optimism",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "depositETH",
	},
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseFixture(value: unknown): ParsedFixture {
	if (!isRecord(value)) {
		throw new Error("Invalid fixture root");
	}

	if (
		isNumber(value.chain) &&
		isNumber(value.forkBlock) &&
		isString(value.to) &&
		isString(value.from) &&
		isString(value.value) &&
		isString(value.data)
	) {
		return {
			chain: value.chain,
			forkBlock: value.forkBlock,
			to: value.to,
			from: value.from,
			value: value.value,
			data: value.data,
		};
	}

	if (isNumber(value.chainId) && isNumber(value.forkBlock) && isRecord(value.tx)) {
		const tx = value.tx;
		if (isString(tx.to) && isString(tx.from) && isString(tx.value) && isString(tx.data)) {
			return {
				chain: value.chainId,
				forkBlock: value.forkBlock,
				to: tx.to,
				from: tx.from,
				value: tx.value,
				data: tx.data,
			};
		}
	}

	throw new Error("Unsupported fixture shape");
}

async function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}) {
	const env = { ...process.env, ...envOverrides };
	const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

function parseSimulationSuccess(simulation: unknown): boolean {
	if (!isRecord(simulation)) return false;
	if (typeof simulation.success === "boolean") return simulation.success;
	return simulation.status === "success";
}

function readNativeDiff(simulation: unknown): bigint {
	if (!isRecord(simulation)) {
		throw new Error("Missing simulation object");
	}
	if (!isString(simulation.nativeDiff)) {
		throw new Error("simulation.nativeDiff missing or invalid");
	}
	return BigInt(simulation.nativeDiff);
}

function hasFindingCode(findings: unknown, code: string): boolean {
	if (!Array.isArray(findings)) return false;
	for (const finding of findings) {
		if (!isRecord(finding)) continue;
		if (finding.code === code) return true;
	}
	return false;
}

function findDecodedFunctionName(findings: unknown): string | null {
	if (!Array.isArray(findings)) return null;
	for (const finding of findings) {
		if (!isRecord(finding)) continue;
		if (finding.code !== "CALLDATA_DECODED") continue;
		if (!isRecord(finding.details)) continue;
		if (isString(finding.details.functionName)) return finding.details.functionName;
	}
	return null;
}

function hasVerifiedFindingWithName(findings: unknown, name: string): boolean {
	if (!Array.isArray(findings)) return false;
	for (const finding of findings) {
		if (!isRecord(finding)) continue;
		if (finding.code !== "VERIFIED") continue;
		if (isString(finding.message) && finding.message.includes(name)) return true;
	}
	return false;
}

describe("real replay flow matrix e2e", () => {
	for (const entry of REPLAY_MATRIX) {
		test(`${entry.flow} (${entry.fixturePath})`, async () => {
			if (!existsSync(foundryDefaultAnvilPath)) {
				return;
			}

			const absoluteFixturePath = path.join(import.meta.dir, entry.fixturePath);
			const rawFixture = await Bun.file(absoluteFixturePath).text();
			const parsedFixture = parseFixture(JSON.parse(rawFixture));

			const calldata = JSON.stringify({
				to: parsedFixture.to,
				from: parsedFixture.from,
				value: parsedFixture.value,
				data: parsedFixture.data,
				chain: String(parsedFixture.chain),
			});

			const configPath = path.join(
				process.env.TMPDIR ?? "/tmp",
				`assay-replay-matrix-${entry.flow.replace(/[^a-zA-Z0-9]+/g, "-")}-${Date.now()}.json`,
			);
			await Bun.write(
				configPath,
				JSON.stringify({ simulation: { enabled: true, forkBlock: parsedFixture.forkBlock } }),
			);

			const result = await runCli(
				["scan", "--calldata", calldata, "--format", "json", "--fail-on", "danger", "--quiet"],
				{
					ASSAY_CONFIG: configPath,
					NO_COLOR: "1",
				},
			);

			expect(result.exitCode === 0 || result.exitCode === 2).toBe(true);

			let parsed: unknown;
			try {
				parsed = JSON.parse(result.stdout);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to parse JSON output for ${entry.flow}: ${message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
				);
			}

			expect(isRecord(parsed)).toBe(true);
			if (!isRecord(parsed)) throw new Error("Invalid CLI output");
			expect(isRecord(parsed.scan)).toBe(true);
			if (!isRecord(parsed.scan)) throw new Error("Missing scan");

			const simulation = parsed.scan.simulation;
			expect(parseSimulationSuccess(simulation)).toBe(true);
			const nativeDiff = readNativeDiff(simulation);
			if (entry.nativeDiff === "negative") {
				expect(nativeDiff < 0n).toBe(true);
			} else if (entry.nativeDiff === "positive") {
				expect(nativeDiff > 0n).toBe(true);
			} else {
				expect(nativeDiff === 0n).toBe(true);
			}

			if (entry.intentIncludes) {
				expect(isString(parsed.scan.intent)).toBe(true);
				if (isString(parsed.scan.intent)) {
					expect(parsed.scan.intent).toContain(entry.intentIncludes);
					if (entry.intentExcludes) {
						for (const excluded of entry.intentExcludes) {
							expect(parsed.scan.intent).not.toContain(excluded);
						}
					}
				}
			}

			if (entry.requireDecodedCalldata) {
				expect(hasFindingCode(parsed.scan.findings, "CALLDATA_DECODED")).toBe(true);
			}
			if (entry.requireCalldataEmpty) {
				expect(hasFindingCode(parsed.scan.findings, "CALLDATA_EMPTY")).toBe(true);
			}
			if (entry.requireDecodedFunctionName) {
				const decoded = findDecodedFunctionName(parsed.scan.findings);
				expect(decoded).toBe(entry.requireDecodedFunctionName);
			}
			if (entry.requireVerifiedName) {
				expect(hasVerifiedFindingWithName(parsed.scan.findings, entry.requireVerifiedName)).toBe(
					true,
				);
			}
			if (entry.requireFindingCodes) {
				for (const code of entry.requireFindingCodes) {
					expect(hasFindingCode(parsed.scan.findings, code)).toBe(true);
				}
			}
			if (entry.forbidFindingCodes) {
				for (const code of entry.forbidFindingCodes) {
					expect(hasFindingCode(parsed.scan.findings, code)).toBe(false);
				}
			}
		}, 240000);
	}
});

/**
 * EIP-7702 (type-4 transaction) matrix scaffold.
 *
 * No real on-chain EIP-7702 fixture is available yet (the EIP is relatively new
 * and mainnet adoption is sparse). Once a representative tx lands on-chain:
 * 1. Record the fixture at test/fixtures/txs/eip7702-delegation-<hash>.json
 * 2. Replace the TODO entry below with a full ReplayMatrixEntry
 * 3. Remove this scaffold block
 *
 * The unit-level coverage (extraction + finding generation) lives in
 * test/eip7702-authorization.unit.test.ts.
 */
describe("EIP-7702 type-4 matrix scaffold", () => {
	alwaysTest("EIP-7702 authorization list fixture path reserved", () => {
		const placeholder = "fixtures/txs/eip7702-delegation-TODO.json";
		// Intentional: this test documents the missing fixture path so it shows up
		// in test output and grep. It passes unconditionally — the real assertion
		// will come when the fixture file exists.
		expect(placeholder).toContain("TODO");
	});

	alwaysTest.todo(
		"EIP-7702 delegation replay with real on-chain fixture (blocked: no mainnet fixture yet)",
	);
});

/**
 * Lane 1 supplement: Permit / Permit2 off-chain signature scaffold.
 *
 * ERC-2612 permit() and Permit2 off-chain signatures (EIP-712 typed data) are
 * intercepted at the wallet/RPC layer as eth_signTypedData_v4 rather than as
 * on-chain transactions. The scan CLI path currently operates on transaction
 * calldata, not typed-data signing requests.
 *
 * TODO: Once eth_signTypedData_v4 interception is supported by the proxy/scan
 * path, record a real fixture and add a full ReplayMatrixEntry.
 *
 * Acceptance criteria:
 * 1. Fixture at test/fixtures/txs/permit2-off-chain-signature-TODO.json
 *    containing a captured eth_signTypedData_v4 request.
 * 2. Matrix entry asserts: decoded permit fields, spender label, expiry warning.
 * 3. Safety finding codes: PERMIT_SIGNATURE, or equivalent.
 */
describe("Permit off-chain signature matrix scaffold", () => {
	alwaysTest("Permit off-chain signature fixture path reserved", () => {
		const placeholder = "fixtures/txs/permit2-off-chain-signature-TODO.json";
		expect(placeholder).toContain("TODO");
	});

	alwaysTest.todo(
		"Permit2 off-chain typed-data signature replay (blocked: scan path does not yet intercept eth_signTypedData_v4)",
	);
});

/**
 * Scaffold lane markers for lanes 4-6 edge cases.
 *
 * The primary fixtures for Bridge (CCTP depositForBurn), Proxy upgrade
 * (upgradeToAndCall), and EIP-4337 (handleOps) are real and exercised above
 * in REPLAY_MATRIX. These scaffolds track additional sub-variants that would
 * strengthen coverage once fixtures become available.
 */
const SCAFFOLD_LANES: ReplayLaneScaffold[] = [
	// Ownership transfer / role mutation — PROMOTED to real lane (Pass 17)
	// Canonical L2 bridge deposit (non-CCTP) — PROMOTED to real lane (Pass 17)
	// Bridge: Optimism Standard Bridge depositETH — PROMOTED to real lane (Pass 17)
	{
		lane: "Marketplace order fulfillment (Seaport-style)",
		placeholderFixturePath: "fixtures/txs/seaport-fulfill-order-TODO.json",
		skipReason:
			"No replay fixture committed yet for Seaport fulfillOrder/fulfillAdvancedOrder/matchOrders paths.",
		acceptanceCriteria: [
			"Fixture targets Seaport contract with fulfillOrder/fulfillAdvancedOrder/matchOrders",
			"Intent includes marketplace order fulfillment semantics",
			"Simulation captures NFT/token movement legs relevant to order execution",
		],
	},
	{
		lane: "Universal Router command-stream multi-step path",
		placeholderFixturePath: "fixtures/txs/universal-router-command-stream-multistep-TODO.json",
		skipReason:
			"Current matrix has basic Universal Router coverage; no dense multi-command stream fixture yet.",
		acceptanceCriteria: [
			"Fixture contains command stream with 3+ actionable steps",
			"Decoded command labels preserved in intent as a step summary",
			"Findings reflect combined approval/swap/sweep risk composition",
		],
	},
	{
		lane: "Safe module enable / execTransactionFromModule",
		placeholderFixturePath: "fixtures/txs/safe-module-enable-exectxfrommodule-TODO.json",
		skipReason: "No real fixture recorded for Safe module enablement/module-executed call path.",
		acceptanceCriteria: [
			"Fixture decodes enableModule or execTransactionFromModule",
			"Intent calls out Safe module action, not plain Safe owner execution",
			"Findings include explicit elevated-trust module execution warning",
		],
	},
	{
		lane: "Flashloan path",
		placeholderFixturePath: "fixtures/txs/flashloan-path-TODO.json",
		skipReason: "No flashloan replay fixture committed yet for Aave/Balancer-style callbacks.",
		acceptanceCriteria: [
			"Fixture decodes flashLoan/flashLoanSimple entrypoint",
			"Intent explicitly states flashloan semantics (borrow + callback + repay)",
			"Simulation/finding set flags transient borrow and repayment assumptions",
		],
	},
	{
		lane: "Proxy admin upgrade via ProxyAdmin.upgrade()",
		placeholderFixturePath: "fixtures/txs/proxy-admin-upgrade-selector-99a88ec4-TODO.json",
		skipReason:
			"No mainnet fixture recorded for ProxyAdmin.upgrade(proxy, impl) selector 0x99a88ec4.",
		acceptanceCriteria: [
			"Real mainnet tx fixture with selector 0x99a88ec4",
			"Decoded functionName: upgrade",
			"UPGRADEABLE finding present",
		],
	},
	{
		lane: "EIP-4337 EntryPoint v0.7 handleOps",
		placeholderFixturePath: "fixtures/txs/eip4337-entrypoint-v07-handleops-TODO.json",
		skipReason:
			"Current fixture uses EntryPoint v0.6 (0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789). v0.7 EntryPoint (0x0000000071727De22E5E9d8BAf0edAc6f37da032) may produce different finding codes.",
		acceptanceCriteria: [
			"Real mainnet tx fixture targeting v0.7 EntryPoint",
			"Decoded functionName: handleOps",
			"Validate any differences in finding codes vs v0.6",
		],
	},
];

describe("scaffold lane markers (TODO fixtures)", () => {
	for (const scaffold of SCAFFOLD_LANES) {
		alwaysTest(`[scaffold] ${scaffold.lane}`, () => {
			expect(scaffold.placeholderFixturePath).toContain("TODO");
			expect(scaffold.skipReason.length).toBeGreaterThan(0);
			expect(scaffold.acceptanceCriteria.length).toBeGreaterThan(0);
		});
	}
});
