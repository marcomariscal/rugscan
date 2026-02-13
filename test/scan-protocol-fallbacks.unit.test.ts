import { describe, expect, test } from "bun:test";
import type { AnalyzerDeps } from "../src/analyzer";
import { scanWithAnalysis } from "../src/scan";

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

async function scanProtocol(to: string, data = "0x"): Promise<string | undefined> {
	const { analysis } = await scanWithAnalysis(
		{
			calldata: {
				to,
				from: SENDER,
				data,
				value: "0",
				chain: "1",
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
	return analysis.protocol;
}

describe("scan protocol labeling fallbacks", () => {
	test("labels ENS for BaseRegistrar target", async () => {
		const protocol = await scanProtocol("0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85");
		expect(protocol).toBe("ENS");
	});

	test("labels OpenSea Seaport for canonical Seaport target", async () => {
		const protocol = await scanProtocol("0x0000000000000068f116a894984e2db1123eb395");
		expect(protocol).toBe("OpenSea Seaport");
	});

	test("labels Circle CCTP for TokenMessenger target", async () => {
		const protocol = await scanProtocol("0xbd3fa81b58ba92a82136038b25adec7066af3155");
		expect(protocol).toBe("Circle CCTP");
	});

	test("labels Safe when calldata matches Safe execution selectors", async () => {
		const protocol = await scanProtocol("0x3d6a4b29fe30fe442d0da3b56fab416d0308b276", "0x5229073f");
		expect(protocol).toBe("Safe");
	});

	test("labels Seamless Protocol for known ILM vault on Base", async () => {
		const { analysis } = await scanWithAnalysis(
			{
				calldata: {
					to: "0x6426811ff283fa7c78f0bc5d71858c2f79c0fc3d",
					from: SENDER,
					data: "0x095ea7b3000000000000000000000000b0764de7eef0ac69855c431334b7bc51a96e6dbaffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
					value: "0",
					chain: "8453",
				},
			},
			{
				chain: "base",
				config: { simulation: { enabled: false } },
				analyzeOptions: {
					deps: createStubDeps(),
				},
			},
		);
		expect(analysis.protocol).toBe("Seamless Protocol");
		expect(analysis.intent).toContain("Approve");
		expect(analysis.intent).toContain("UNLIMITED");
	});

	test("labels Seamless Protocol for ILM 3x Loop vault redeem on Base", async () => {
		const { analysis } = await scanWithAnalysis(
			{
				calldata: {
					to: "0x258730e23cf2f25887cb962d32bd10b878ea8a4e",
					from: "0x6b821bd540ef180ab6e8219af224f9ba52045471",
					data: "0xba0876520000000000000000000000000000000000000000000000000007167d69daff890000000000000000000000006b821bd540ef180ab6e8219af224f9ba520454710000000000000000000000006b821bd540ef180ab6e8219af224f9ba52045471",
					value: "0",
					chain: "8453",
				},
			},
			{
				chain: "base",
				config: { simulation: { enabled: false } },
				analyzeOptions: {
					deps: createStubDeps(),
				},
			},
		);
		expect(analysis.protocol).toBe("Seamless Protocol");
		expect(analysis.intent).toContain("Redeem");
		expect(analysis.intent).toContain("shares");
	});
});
