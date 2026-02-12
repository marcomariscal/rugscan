import { describe, expect, test } from "bun:test";
import {
	analyzeSignTypedDataV4Risk,
	extractSignTypedDataV4Payload,
} from "../src/jsonrpc/sign-typed-data";

describe("eth_signTypedData_v4 parser + permit risk classification", () => {
	test("extracts typed-data payload from JSON-string params", () => {
		const params = [
			"0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
			JSON.stringify({
				types: {
					EIP712Domain: [{ name: "name", type: "string" }],
					Permit: [
						{ name: "owner", type: "address" },
						{ name: "spender", type: "address" },
						{ name: "value", type: "uint256" },
						{ name: "deadline", type: "uint256" },
					],
				},
				primaryType: "Permit",
				domain: { chainId: "0x1" },
				message: {
					owner: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
					spender: "0x9999999999999999999999999999999999999999",
					value: "1",
					deadline: "1700000100",
				},
			}),
		];

		const parsed = extractSignTypedDataV4Payload(params);
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		expect(parsed.account).toBe("0x24274566a1ad6a9b056e8e2618549ebd2f5141a7");
		expect(parsed.typedData.primaryType).toBe("Permit");
		expect(parsed.typedData.message.spender).toBe("0x9999999999999999999999999999999999999999");
	});

	test("returns null for malformed v4 params", () => {
		const parsed = extractSignTypedDataV4Payload([
			"0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
			"not-json",
		]);
		expect(parsed).toBeNull();
	});

	test("classifies permit-like unlimited + no-expiry payload as warning", () => {
		const parsed = extractSignTypedDataV4Payload([
			"0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
			{
				types: {
					EIP712Domain: [{ name: "name", type: "string" }],
					PermitSingle: [
						{ name: "details", type: "PermitDetails" },
						{ name: "spender", type: "address" },
						{ name: "sigDeadline", type: "uint256" },
					],
					PermitDetails: [
						{ name: "token", type: "address" },
						{ name: "amount", type: "uint160" },
						{ name: "expiration", type: "uint48" },
						{ name: "nonce", type: "uint48" },
					],
				},
				primaryType: "PermitSingle",
				domain: { chainId: 1 },
				message: {
					details: {
						token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
						amount: "1461501637330902918203684832716283019655932542975",
						expiration: "0",
						nonce: "12",
					},
					spender: "0x9999999999999999999999999999999999999999",
					sigDeadline: "0",
				},
			},
		]);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		const assessment = analyzeSignTypedDataV4Risk(parsed, { nowUnix: 1_700_000_000n });
		expect(assessment.permitLike).toBe(true);
		expect(assessment.recommendation).toBe("warning");
		expect(assessment.spender).toBe("0x9999999999999999999999999999999999999999");
		expect(assessment.findings.some((f) => f.code === "PERMIT_SIGNATURE")).toBe(true);
		expect(assessment.findings.some((f) => f.code === "PERMIT_UNLIMITED_ALLOWANCE")).toBe(true);
		expect(assessment.findings.some((f) => f.code === "PERMIT_ZERO_EXPIRY")).toBe(true);
		expect(assessment.actionableNotes.join(" ")).toContain("full token drain");
	});

	test("classifies bounded short-lived permit as caution", () => {
		const parsed = extractSignTypedDataV4Payload([
			"0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
			{
				types: {
					EIP712Domain: [{ name: "name", type: "string" }],
					Permit: [
						{ name: "owner", type: "address" },
						{ name: "spender", type: "address" },
						{ name: "value", type: "uint256" },
						{ name: "nonce", type: "uint256" },
						{ name: "deadline", type: "uint256" },
					],
				},
				primaryType: "Permit",
				domain: { chainId: "1" },
				message: {
					owner: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
					spender: "0x3333333333333333333333333333333333333333",
					value: "1000000",
					nonce: "7",
					deadline: "1700000600",
				},
			},
		]);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		const assessment = analyzeSignTypedDataV4Risk(parsed, { nowUnix: 1_700_000_000n });
		expect(assessment.recommendation).toBe("caution");
		expect(assessment.findings.some((f) => f.code === "PERMIT_SIGNATURE")).toBe(true);
		expect(assessment.findings.some((f) => f.code === "PERMIT_UNLIMITED_ALLOWANCE")).toBe(false);
		expect(assessment.findings.some((f) => f.code === "PERMIT_LONG_EXPIRY")).toBe(false);
		expect(assessment.actionableNotes.join(" ")).toContain(
			"0x3333333333333333333333333333333333333333",
		);
	});

	test("classifies expired permit deadline as warning", () => {
		const parsed = extractSignTypedDataV4Payload([
			"0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
			{
				types: {
					EIP712Domain: [{ name: "name", type: "string" }],
					Permit: [
						{ name: "owner", type: "address" },
						{ name: "spender", type: "address" },
						{ name: "value", type: "uint256" },
						{ name: "nonce", type: "uint256" },
						{ name: "deadline", type: "uint256" },
					],
				},
				primaryType: "Permit",
				domain: { chainId: "1" },
				message: {
					owner: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
					spender: "0x4444444444444444444444444444444444444444",
					value: "1000000",
					nonce: "9",
					deadline: "1699999900",
				},
			},
		]);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		const assessment = analyzeSignTypedDataV4Risk(parsed, { nowUnix: 1_700_000_000n });
		expect(assessment.recommendation).toBe("warning");
		expect(assessment.findings.some((f) => f.code === "PERMIT_EXPIRED_DEADLINE")).toBe(true);
		expect(assessment.findings.some((f) => f.code === "PERMIT_LONG_EXPIRY")).toBe(false);
		expect(assessment.actionableNotes.join(" ")).toContain("already expired");
	});

	test("returns ok for non-permit typed data", () => {
		const parsed = extractSignTypedDataV4Payload([
			"0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
			{
				types: {
					EIP712Domain: [{ name: "name", type: "string" }],
					Mail: [
						{ name: "from", type: "address" },
						{ name: "contents", type: "string" },
					],
				},
				primaryType: "Mail",
				domain: { chainId: "1" },
				message: {
					from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
					contents: "hello",
				},
			},
		]);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		const assessment = analyzeSignTypedDataV4Risk(parsed, { nowUnix: 1_700_000_000n });
		expect(assessment.permitLike).toBe(false);
		expect(assessment.recommendation).toBe("ok");
		expect(assessment.findings.length).toBe(0);
	});
});
