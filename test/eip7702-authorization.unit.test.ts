import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { AnalyzerDeps } from "../src/analyzer";
import {
	extractSendRawTransactionCalldata,
	extractSendTransactionCalldata,
} from "../src/jsonrpc/proxy";
import { scanWithAnalysis } from "../src/scan";

const DELEGATE_CONTRACT = "0x1234567890abcdef1234567890abcdef12345678";
const TARGET_CONTRACT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const SENDER = "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7";

function createStubDeps(): AnalyzerDeps {
	return {
		defillama: {
			matchProtocol: async () => null,
		},
		etherscan: {
			getAddressLabels: async () => null,
			getContractData: async () => null,
		},
		goplus: {
			getTokenSecurity: async () => ({ data: null }),
		},
		proxy: {
			isContract: async () => true,
			detectProxy: async () => ({ is_proxy: false }),
		},
		sourcify: {
			checkVerification: async () => ({
				verified: true,
				verificationKnown: true,
				name: "Stub Verified Contract",
			}),
		},
	};
}

describe("EIP-7702 authorization list — proxy extraction", () => {
	test("extractSendTransactionCalldata preserves authorizationList", () => {
		const calldata = extractSendTransactionCalldata({
			jsonrpc: "2.0",
			id: 1,
			method: "eth_sendTransaction",
			params: [
				{
					to: TARGET_CONTRACT,
					from: SENDER,
					data: "0x",
					value: "0x0",
					chainId: "0x1",
					authorizationList: [
						{
							address: DELEGATE_CONTRACT,
							chainId: "0x1",
							nonce: "0x0",
						},
					],
				},
			],
		});

		expect(calldata).not.toBeNull();
		if (!calldata) return;
		expect(calldata.authorizationList).toHaveLength(1);
		if (!calldata.authorizationList) return;
		expect(calldata.authorizationList[0]?.address).toBe(DELEGATE_CONTRACT);
		expect(calldata.authorizationList[0]?.chainId).toBe(1);
		expect(calldata.authorizationList[0]?.nonce).toBe(0);
	});

	test("extractSendTransactionCalldata ignores malformed authorizationList entries", () => {
		const calldata = extractSendTransactionCalldata({
			jsonrpc: "2.0",
			id: 1,
			method: "eth_sendTransaction",
			params: [
				{
					to: TARGET_CONTRACT,
					from: SENDER,
					data: "0x",
					value: "0x0",
					chainId: "0x1",
					authorizationList: [
						{ address: "not-an-address", chainId: "0x1", nonce: "0x0" },
						{ address: DELEGATE_CONTRACT, chainId: "0x1", nonce: "0x0" },
					],
				},
			],
		});

		expect(calldata).not.toBeNull();
		if (!calldata) return;
		expect(calldata.authorizationList).toHaveLength(1);
		expect(calldata.authorizationList?.[0]?.address).toBe(DELEGATE_CONTRACT);
	});

	test("extractSendRawTransactionCalldata preserves authorizationList from signed type-4 envelope", async () => {
		const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
		const signedAuthorization = await account.signAuthorization({
			chainId: 1,
			nonce: 7,
			address: DELEGATE_CONTRACT,
		});
		const raw = await account.signTransaction({
			chainId: 1,
			type: "eip7702",
			to: TARGET_CONTRACT,
			value: 123n,
			data: "0x1234",
			nonce: 0,
			gas: 21_000n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			authorizationList: [signedAuthorization],
		});

		const calldata = await extractSendRawTransactionCalldata({
			jsonrpc: "2.0",
			id: 1,
			method: "eth_sendRawTransaction",
			params: [raw],
		});

		expect(calldata).not.toBeNull();
		if (!calldata) return;
		expect(calldata.to).toBe(TARGET_CONTRACT);
		expect(calldata.from?.toLowerCase()).toBe(account.address.toLowerCase());
		expect(calldata.data).toBe("0x1234");
		expect(calldata.value).toBe("123");
		expect(calldata.chain).toBe("1");
		expect(calldata.authorizationList).toHaveLength(1);
		expect(calldata.authorizationList?.[0]?.address.toLowerCase()).toBe(
			DELEGATE_CONTRACT.toLowerCase(),
		);
		expect(calldata.authorizationList?.[0]?.chainId).toBe(1);
		expect(calldata.authorizationList?.[0]?.nonce).toBe(7);
	});
});

describe("EIP-7702 authorization list — scan findings", () => {
	test("scanWithAnalysis surfaces explicit EIP7702_AUTHORIZATION warning", async () => {
		const { analysis, response } = await scanWithAnalysis(
			{
				calldata: {
					to: TARGET_CONTRACT,
					from: SENDER,
					data: "0x",
					value: "0",
					chain: "1",
					authorizationList: [
						{
							address: DELEGATE_CONTRACT,
							chainId: 1,
							nonce: 7,
						},
					],
				},
			},
			{
				chain: "ethereum",
				config: { simulation: { enabled: false } },
				analyzeOptions: {
					deps: createStubDeps(),
				},
			},
		);

		const finding = analysis.findings.find((entry) => entry.code === "EIP7702_AUTHORIZATION");
		expect(finding).toBeDefined();
		expect(finding?.level).toBe("warning");
		expect(finding?.message).toContain("delegates sender EOA");
		expect(analysis.recommendation).toBe("caution");
		expect(analysis.intent).toBe(`Delegate sender EOA to ${DELEGATE_CONTRACT} via EIP-7702`);
		expect(response.scan.intent).toBe(`Delegate sender EOA to ${DELEGATE_CONTRACT} via EIP-7702`);

		const responseFinding = response.scan.findings.find(
			(entry) => entry.code === "EIP7702_AUTHORIZATION",
		);
		expect(responseFinding).toBeDefined();
		expect(responseFinding?.severity).toBe("warning");
		expect(responseFinding?.details).toBeDefined();
	});
});
