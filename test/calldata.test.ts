import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Abi } from "viem";
import { encodeFunctionData } from "viem";
import { analyzeCalldata } from "../src/analyzers/calldata";
import { clearSelectorCache, resolveSelector } from "../src/analyzers/calldata/selector-resolver";
import { isRecord } from "../src/analyzers/calldata/utils";
import { MAX_UINT256 } from "../src/constants";

const ERC20_ABI: Abi = [
	{
		type: "function",
		name: "approve",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "transfer",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "transferFrom",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
];

const PERMIT_ABI: Abi = [
	{
		type: "function",
		name: "permit",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "spender", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "deadline", type: "uint256" },
			{ name: "v", type: "uint8" },
			{ name: "r", type: "bytes32" },
			{ name: "s", type: "bytes32" },
		],
		outputs: [],
	},
];

const CUSTOM_ABI: Abi = [
	{
		type: "function",
		name: "doThing",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "target", type: "address" },
			{ name: "count", type: "uint256" },
		],
		outputs: [],
	},
];

let originalFetch: typeof fetch;

beforeAll(() => {
	originalFetch = globalThis.fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

beforeEach(() => {
	clearSelectorCache();
	globalThis.fetch = originalFetch;
});

describe("calldata analysis", () => {
	test("decodes ERC-20 approve and flags unlimited approval", async () => {
		const data = encodeFunctionData({
			abi: ERC20_ABI,
			functionName: "approve",
			args: ["0x0000000000000000000000000000000000000001", MAX_UINT256],
		});
		const result = await analyzeCalldata({
			to: "0x0000000000000000000000000000000000000002",
			data,
		});

		expect(result.findings.some((finding) => finding.code === "CALLDATA_DECODED")).toBe(true);
		expect(result.findings.some((finding) => finding.code === "UNLIMITED_APPROVAL")).toBe(true);
	});

	test("decodes ERC-20 transfer with semantic output", async () => {
		const data = encodeFunctionData({
			abi: ERC20_ABI,
			functionName: "transfer",
			args: ["0x0000000000000000000000000000000000000003", 123n],
		});
		const result = await analyzeCalldata({
			to: "0x0000000000000000000000000000000000000004",
			data,
		});

		const decoded = result.findings.find((finding) => finding.code === "CALLDATA_DECODED");
		expect(decoded).toBeDefined();
		if (decoded?.details && isRecord(decoded.details)) {
			expect(decoded.details.standard).toBe("erc20");
			if (isRecord(decoded.details.args)) {
				expect(decoded.details.args.to).toBe("0x0000000000000000000000000000000000000003");
				expect(decoded.details.args.amount).toBe("123");
			}
		}
	});

	test("decodes EIP-2612 permit and flags unlimited approval", async () => {
		const data = encodeFunctionData({
			abi: PERMIT_ABI,
			functionName: "permit",
			args: [
				"0x0000000000000000000000000000000000000005",
				"0x0000000000000000000000000000000000000006",
				MAX_UINT256,
				0n,
				1,
				"0x0000000000000000000000000000000000000000000000000000000000000000",
				"0x0000000000000000000000000000000000000000000000000000000000000000",
			],
		});
		const result = await analyzeCalldata({
			to: "0x0000000000000000000000000000000000000007",
			data,
		});

		expect(result.findings.some((finding) => finding.code === "CALLDATA_DECODED")).toBe(true);
		expect(result.findings.some((finding) => finding.code === "UNLIMITED_APPROVAL")).toBe(true);
	});

	test("uses local router selector fallback for real universal router payloads", async () => {
		let calls = 0;
		globalThis.fetch = async () => {
			calls += 1;
			throw new Error("network fetch should not be called in offline fallback test");
		};

		const rawFixture = await Bun.file(
			`${import.meta.dir}/fixtures/txs/uniswap-v4-universalrouter-eth-swap-873d55dd.json`,
		).text();
		const parsedFixture: unknown = JSON.parse(rawFixture);
		expect(isRecord(parsedFixture)).toBe(true);
		if (!isRecord(parsedFixture)) throw new Error("Invalid fixture root");
		expect(isRecord(parsedFixture.tx)).toBe(true);
		if (!isRecord(parsedFixture.tx)) throw new Error("Invalid fixture tx");
		expect(typeof parsedFixture.tx.to).toBe("string");
		expect(typeof parsedFixture.tx.data).toBe("string");
		if (typeof parsedFixture.tx.to !== "string" || typeof parsedFixture.tx.data !== "string") {
			throw new Error("Invalid fixture tx calldata");
		}

		const result = await analyzeCalldata(
			{
				to: parsedFixture.tx.to,
				data: parsedFixture.tx.data,
			},
			undefined,
			{ offline: true },
		);

		expect(calls).toBe(0);
		const decoded = result.findings.find((finding) => finding.code === "CALLDATA_DECODED");
		expect(decoded).toBeDefined();
		if (decoded?.details && isRecord(decoded.details)) {
			expect(decoded.details.source).toBe("local-selector");
			expect(decoded.details.signature).toBe("execute(bytes,bytes[],uint256)");
			expect(decoded.details.functionName).toBe("execute");
		}
	});

	test("uses local router selector fallback for common v2 swap selectors", async () => {
		const result = await analyzeCalldata(
			{
				to: "0x0000000000000000000000000000000000000001",
				data: "0x7ff36ab5",
			},
			undefined,
			{ offline: true },
		);

		const decoded = result.findings.find((finding) => finding.code === "CALLDATA_DECODED");
		expect(decoded).toBeDefined();
		if (decoded?.details && isRecord(decoded.details)) {
			expect(decoded.details.source).toBe("local-selector");
			expect(decoded.details.signature).toBe(
				"swapExactETHForTokens(uint256,address[],address,uint256)",
			);
			expect(decoded.details.functionName).toBe("swapExactETHForTokens");
		}
	});

	test("falls back to 4byte signature lookup", async () => {
		let calls = 0;
		globalThis.fetch = async () => {
			calls += 1;
			return new Response(
				JSON.stringify({
					results: [{ text_signature: "doThing(address,uint256)" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const data = encodeFunctionData({
			abi: CUSTOM_ABI,
			functionName: "doThing",
			args: ["0x0000000000000000000000000000000000000008", 5n],
		});
		const result = await analyzeCalldata({
			to: "0x0000000000000000000000000000000000000009",
			data,
		});

		expect(calls).toBe(1);
		const decoded = result.findings.find((finding) => finding.code === "CALLDATA_DECODED");
		expect(decoded).toBeDefined();
		if (decoded?.details && isRecord(decoded.details)) {
			expect(decoded.details.source).toBe("signature-db");
		}
	});

	test("decodes using Sourcify ABI when available", async () => {
		let calls = 0;
		globalThis.fetch = async (input) => {
			calls += 1;
			const url = typeof input === "string" ? input : input.url;
			if (!url.includes("sourcify.dev")) {
				throw new Error(`Unexpected fetch: ${url}`);
			}
			const metadata = {
				output: {
					abi: CUSTOM_ABI,
				},
			};
			return new Response(
				JSON.stringify({
					status: "full",
					files: [
						{
							name: "metadata.json",
							path: "",
							content: JSON.stringify(metadata),
						},
						{
							name: "Contract.sol",
							path: "",
							content: "contract Contract {}",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const data = encodeFunctionData({
			abi: CUSTOM_ABI,
			functionName: "doThing",
			args: ["0x0000000000000000000000000000000000000008", 5n],
		});
		const result = await analyzeCalldata(
			{
				to: "0x0000000000000000000000000000000000000009",
				data,
			},
			"ethereum",
		);

		expect(calls).toBe(1);
		const decoded = result.findings.find((finding) => finding.code === "CALLDATA_DECODED");
		expect(decoded).toBeDefined();
		if (decoded?.details && isRecord(decoded.details)) {
			expect(decoded.details.source).toBe("contract-abi");
			if (isRecord(decoded.details.args)) {
				expect(decoded.details.args.target).toBe("0x0000000000000000000000000000000000000008");
				expect(decoded.details.args.count).toBe("5");
			}
		}
	});

	test("selector resolver caches results", async () => {
		let calls = 0;
		globalThis.fetch = async () => {
			calls += 1;
			return new Response(
				JSON.stringify({
					results: [{ text_signature: "cached(uint256)" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const first = await resolveSelector("0x12345678");
		const second = await resolveSelector("0x12345678");

		expect(first.signatures.length).toBe(1);
		expect(second.cached).toBe(true);
		expect(calls).toBe(1);
	});
});
