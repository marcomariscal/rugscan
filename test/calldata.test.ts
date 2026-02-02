import { beforeAll, beforeEach, afterAll, describe, expect, test } from "bun:test";
import { encodeFunctionData } from "viem";
import type { Abi } from "viem";
import { MAX_UINT256 } from "../src/constants";
import { analyzeCalldata } from "../src/analyzers/calldata";
import { clearSelectorCache, resolveSelector } from "../src/analyzers/calldata/selector-resolver";
import { isRecord } from "../src/analyzers/calldata/utils";

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

		expect(result.findings.some((finding) => finding.code === "CALLDATA_DECODED")).toBe(
			true,
		);
		expect(result.findings.some((finding) => finding.code === "UNLIMITED_APPROVAL")).toBe(
			true,
		);
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
				expect(decoded.details.args.to).toBe(
					"0x0000000000000000000000000000000000000003",
				);
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

		expect(result.findings.some((finding) => finding.code === "CALLDATA_DECODED")).toBe(
			true,
		);
		expect(result.findings.some((finding) => finding.code === "UNLIMITED_APPROVAL")).toBe(
			true,
		);
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
