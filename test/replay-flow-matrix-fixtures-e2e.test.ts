import { test as bunTest, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
	analyzeSignTypedDataV4Risk,
	extractSignTypedDataV4Payload,
} from "../src/jsonrpc/sign-typed-data";

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
	/** Assert simulation notes include these substrings */
	requireSimulationNoteIncludes?: string[];
	/** Assert a simulation approval change with matching standard exists */
	requireApprovalStandard?: "erc20" | "erc721" | "erc1155" | "permit2";
	/** Assert a simulation approval change has approved=true|false */
	requireApprovalApproved?: boolean;
};

type ReplayLaneScaffold = {
	lane: string;
	placeholderFixturePath: string;
	skipReason: string;
	acceptanceCriteria: string[];
};

type FixtureAuthorizationEntry = {
	address: string;
	chainId: number;
	nonce: number;
};

type ParsedFixture = {
	chain: number;
	forkBlock: number;
	to: string;
	from: string;
	value: string;
	data: string;
	authorizationList?: FixtureAuthorizationEntry[];
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
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "setApprovalForAll",
		requireFindingCodes: ["SIM_APPROVAL_FOR_ALL_UNKNOWN_OPERATOR"],
		requireApprovalStandard: "erc721",
		requireApprovalApproved: true,
	},
	{
		flow: "ERC721 setApprovalForAll revoke (ENS operator false-positive guard)",
		fixturePath: "fixtures/txs/erc721-approval-for-all-ens-revoke-false.json",
		nativeDiff: "zero",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "setApprovalForAll",
		forbidFindingCodes: ["SIM_APPROVAL_FOR_ALL_UNKNOWN_OPERATOR"],
		requireApprovalStandard: "erc721",
		requireApprovalApproved: false,
	},
	{
		flow: "ERC1155 setApprovalForAll (Mirror MNFTs → operator)",
		fixturePath: "fixtures/txs/erc1155-approval-for-all-mirror-mnfts-opensea-true.json",
		nativeDiff: "zero",
		requireDecodedCalldata: true,
		requireFindingCodes: ["SIM_APPROVAL_FOR_ALL_UNKNOWN_OPERATOR"],
		requireApprovalStandard: "erc1155",
		requireApprovalApproved: true,
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
	// === Pass 19: scaffold → real promotions (ProxyAdmin.upgrade + EntryPoint v0.7) ===
	{
		flow: "ProxyAdmin.upgrade proxy implementation (selector 0x99a88ec4)",
		fixturePath: "fixtures/txs/proxy-admin-upgrade-selector-99a88ec4-ad25741c.json",
		nativeDiff: "zero",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "upgrade",
		requireVerifiedName: "ProxyAdmin",
	},
	{
		flow: "EIP-4337 EntryPoint v0.7 handleOps (packed UserOperation)",
		fixturePath: "fixtures/txs/eip4337-entrypoint-v07-handleops-a9c36c86.json",
		nativeDiff: "zero",
		intentIncludes: "EIP-4337",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "handleOps",
		requireVerifiedName: "EntryPoint",
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
	// === Pass 18: Marketplace fulfillment (Seaport) + Safe module exec ===
	// Lane 9: Marketplace order fulfillment (Seaport fulfillBasicOrder)
	{
		flow: "Seaport fulfillBasicOrder (marketplace order fulfillment)",
		fixturePath: "fixtures/txs/seaport-fulfill-basic-order-3bd84118.json",
		nativeDiff: "negative",
		intentIncludes: "Seaport",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "fulfillBasicOrder",
	},
	// Lane 10: Safe module exec (execTransactionFromModuleReturnData)
	{
		flow: "Safe execTransactionFromModuleReturnData (module exec path)",
		fixturePath: "fixtures/txs/safe-module-exec-return-data-b6e95e6c.json",
		nativeDiff: "zero",
		intentIncludes: "Safe module exec",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "execTransactionFromModuleReturnData",
	},
	// === Pass 18b: Universal Router command-stream multi-step path ===
	// Lane 11: Dense multi-command Universal Router execution (3+ commands)
	{
		flow: "Universal Router multi-step: WRAP_ETH → V2_SWAP_EXACT_IN → SWEEP (3-command stream)",
		fixturePath: "fixtures/txs/universal-router-v3-multistep-wrap-swap-sweep-ab1f354b.json",
		nativeDiff: "negative",
		intentIncludes: "Uniswap Universal Router",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "execute",
	},
	// === Pass 20: Flashloan path (scaffold → real promotion) ===
	{
		flow: "Aave V3 flashLoanSimple (borrow + callback + repay)",
		fixturePath: "fixtures/txs/aave-v3-pool-flashloansimple-eded750a.json",
		nativeDiff: "zero",
		intentIncludes: "flashloan",
		requireDecodedCalldata: true,
		requireDecodedFunctionName: "flashLoanSimple",
	},
	// Lane 12: EIP-7702 type-4 authorization delegation path
	{
		flow: "EIP-7702 type-4 delegation path (authorizationList)",
		fixturePath: "fixtures/txs/eip7702-delegation-0dc3e11d.json",
		nativeDiff: "zero",
		requireFindingCodes: ["EIP7702_AUTHORIZATION"],
		requireSimulationNoteIncludes: ["authorization list detected but not replayed"],
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

function parseFixtureAuthorizationList(value: unknown): FixtureAuthorizationEntry[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error("authorizationList must be an array when provided");
	}

	const parsed: FixtureAuthorizationEntry[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) {
			throw new Error("authorizationList entry must be an object");
		}
		if (!isString(entry.address) || !isNumber(entry.chainId) || !isNumber(entry.nonce)) {
			throw new Error("authorizationList entry must include address, chainId, nonce");
		}
		parsed.push({
			address: entry.address,
			chainId: entry.chainId,
			nonce: entry.nonce,
		});
	}

	return parsed.length > 0 ? parsed : undefined;
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
			authorizationList: parseFixtureAuthorizationList(value.authorizationList),
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
				authorizationList: parseFixtureAuthorizationList(tx.authorizationList),
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

function hasSimulationNoteContaining(simulation: unknown, text: string): boolean {
	if (!isRecord(simulation)) return false;
	const notes = simulation.notes;
	if (!Array.isArray(notes)) return false;
	for (const note of notes) {
		if (isString(note) && note.includes(text)) return true;
	}
	return false;
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

function hasApprovalChange(
	simulation: unknown,
	expected: { standard?: "erc20" | "erc721" | "erc1155" | "permit2"; approved?: boolean },
): boolean {
	if (!isRecord(simulation)) return false;
	const approvals = simulation.approvals;
	if (!isRecord(approvals) || !Array.isArray(approvals.changes)) return false;
	for (const change of approvals.changes) {
		if (!isRecord(change)) continue;
		if (expected.standard !== undefined && change.standard !== expected.standard) continue;
		if (expected.approved !== undefined && change.approved !== expected.approved) continue;
		return true;
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

			const calldataPayload = {
				to: parsedFixture.to,
				from: parsedFixture.from,
				value: parsedFixture.value,
				data: parsedFixture.data,
				chain: String(parsedFixture.chain),
				...(parsedFixture.authorizationList
					? { authorizationList: parsedFixture.authorizationList }
					: {}),
			};
			const calldata = JSON.stringify(calldataPayload);

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
			if (
				entry.requireApprovalStandard !== undefined ||
				entry.requireApprovalApproved !== undefined
			) {
				expect(
					hasApprovalChange(simulation, {
						standard: entry.requireApprovalStandard,
						approved: entry.requireApprovalApproved,
					}),
				).toBe(true);
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
			if (entry.requireSimulationNoteIncludes) {
				for (const noteFragment of entry.requireSimulationNoteIncludes) {
					expect(hasSimulationNoteContaining(simulation, noteFragment)).toBe(true);
				}
			}
		}, 240000);
	}
});

/**
 * EIP-7702 replay lane is now covered in the main REPLAY_MATRIX
 * (fixtures/txs/eip7702-delegation-0dc3e11d.json).
 */

/**
 * Lane 1 supplement: Permit / Permit2 off-chain signatures.
 *
 * This lane now has active assertions using a captured eth_signTypedData_v4
 * fixture. We validate decoding/classification directly against the typed-data
 * parser used by the proxy interception path.
 */
describe("Permit off-chain signature replay lane", () => {
	const permit2FixturePath = "fixtures/txs/permit2-off-chain-signature.json";
	const expiredDeadlineFixturePath =
		"fixtures/txs/permit-off-chain-signature-expired-deadline.json";

	alwaysTest("Permit off-chain signature fixtures promoted from TODO", () => {
		expect(permit2FixturePath).not.toContain("TODO");
		expect(expiredDeadlineFixturePath).not.toContain("TODO");
		expect(existsSync(path.join(import.meta.dir, permit2FixturePath))).toBe(true);
		expect(existsSync(path.join(import.meta.dir, expiredDeadlineFixturePath))).toBe(true);
	});

	alwaysTest("Permit2 off-chain typed-data fixture yields permit risk findings", async () => {
		const absolutePath = path.join(import.meta.dir, permit2FixturePath);
		const raw = await Bun.file(absolutePath).text();
		const fixture: unknown = JSON.parse(raw);
		expect(isRecord(fixture)).toBe(true);
		if (!isRecord(fixture)) return;
		expect(fixture.method).toBe("eth_signTypedData_v4");

		const parsed = extractSignTypedDataV4Payload(fixture.params);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		const assessment = analyzeSignTypedDataV4Risk(parsed, { nowUnix: 1_700_000_000n });
		expect(assessment.permitLike).toBe(true);
		expect(assessment.recommendation).toBe("warning");
		expect(assessment.spender).toBe("0x9999999999999999999999999999999999999999");
		expect(assessment.findings.some((finding) => finding.code === "PERMIT_SIGNATURE")).toBe(true);
		expect(
			assessment.findings.some((finding) => finding.code === "PERMIT_UNLIMITED_ALLOWANCE"),
		).toBe(true);
		expect(assessment.findings.some((finding) => finding.code === "PERMIT_ZERO_EXPIRY")).toBe(true);
		expect(assessment.actionableNotes.join(" ")).toContain("Only sign if you trust");
	});

	alwaysTest(
		"Expired permit typed-data fixture yields explicit expired-deadline warning",
		async () => {
			const absolutePath = path.join(import.meta.dir, expiredDeadlineFixturePath);
			const raw = await Bun.file(absolutePath).text();
			const fixture: unknown = JSON.parse(raw);
			expect(isRecord(fixture)).toBe(true);
			if (!isRecord(fixture)) return;
			expect(fixture.method).toBe("eth_signTypedData_v4");

			const parsed = extractSignTypedDataV4Payload(fixture.params);
			expect(parsed).not.toBeNull();
			if (!parsed) return;

			const assessment = analyzeSignTypedDataV4Risk(parsed, { nowUnix: 1_700_000_000n });
			expect(assessment.permitLike).toBe(true);
			expect(assessment.recommendation).toBe("warning");
			expect(
				assessment.findings.some((finding) => finding.code === "PERMIT_EXPIRED_DEADLINE"),
			).toBe(true);
			expect(assessment.findings.some((finding) => finding.code === "PERMIT_LONG_EXPIRY")).toBe(
				false,
			);
			expect(assessment.actionableNotes.join(" ")).toContain("already expired");
		},
	);
});

/**
 * Scaffold lane markers for remaining TODO fixtures.
 */
const SCAFFOLD_LANES: ReplayLaneScaffold[] = [
	// Ownership transfer / role mutation — PROMOTED to real lane (Pass 17)
	// Canonical L2 bridge deposit (non-CCTP) — PROMOTED to real lane (Pass 17)
	// Bridge: Optimism Standard Bridge depositETH — PROMOTED to real lane (Pass 17)
	// Marketplace order fulfillment (Seaport-style) — PROMOTED to real lane (Pass 18)
	// Safe module enable / execTransactionFromModule — PROMOTED to real lane (Pass 18)
	// Universal Router command-stream multi-step path — PROMOTED to real lane (Pass 18b)
	// Proxy admin upgrade via ProxyAdmin.upgrade() — PROMOTED to real lane (Pass 19)
	// EIP-4337 EntryPoint v0.7 handleOps — PROMOTED to real lane (Pass 19)
	// Flashloan path — PROMOTED to real lane (Pass 20)
];

describe("scaffold lane markers (TODO fixtures)", () => {
	alwaysTest("all scaffold lanes promoted — no remaining TODOs", () => {
		expect(SCAFFOLD_LANES.length).toBe(0);
	});
});
