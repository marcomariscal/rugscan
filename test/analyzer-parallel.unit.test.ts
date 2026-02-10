import { describe, expect, test } from "bun:test";
import { type AnalyzerDeps, analyze } from "../src/analyzer";
import type {
	Chain,
	Config,
	EtherscanData,
	ProtocolMatch,
	TokenSecurity,
	VerificationResult,
} from "../src/types";

type ConcurrencyTracker = {
	inFlight: number;
	maxInFlight: number;
};

function createTracker(): ConcurrencyTracker {
	return { inFlight: 0, maxInFlight: 0 };
}

async function delay<T>(ms: number, value: T): Promise<T> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
	return value;
}

async function withConcurrency<T>(tracker: ConcurrencyTracker, ms: number, value: T): Promise<T> {
	tracker.inFlight += 1;
	tracker.maxInFlight = Math.max(tracker.maxInFlight, tracker.inFlight);
	try {
		return await delay(ms, value);
	} finally {
		tracker.inFlight -= 1;
	}
}

function createDeps(options: {
	baseTracker?: ConcurrencyTracker;
	implTracker?: ConcurrencyTracker;
	sourcifyMain: VerificationResult;
	sourcifyImpl?: VerificationResult;
	labels?: { nametag?: string; labels: string[] } | null;
	etherscan?: EtherscanData | null;
	defillama?: ProtocolMatch | null;
	defillamaImpl?: ProtocolMatch | null;
	proxy?: {
		is_proxy: boolean;
		implementation?: string;
		proxy_type?: "eip1967" | "uups" | "beacon" | "minimal" | "unknown";
	};
	token?: TokenSecurity | null;
	delayMs?: number;
}): AnalyzerDeps {
	const baseDelay = options.delayMs ?? 20;
	const implAddress = options.proxy?.implementation?.toLowerCase();

	return {
		defillama: {
			matchProtocol: async (address: string) => {
				const normalized = address.toLowerCase();
				if (implAddress && normalized === implAddress) {
					if (options.implTracker) {
						return await withConcurrency(
							options.implTracker,
							baseDelay,
							options.defillamaImpl ?? null,
						);
					}
					return await delay(baseDelay, options.defillamaImpl ?? null);
				}
				if (options.baseTracker) {
					return await withConcurrency(options.baseTracker, baseDelay, options.defillama ?? null);
				}
				return await delay(baseDelay, options.defillama ?? null);
			},
		},
		etherscan: {
			getAddressLabels: async () => {
				if (options.baseTracker) {
					return await withConcurrency(options.baseTracker, baseDelay, options.labels ?? null);
				}
				return await delay(baseDelay, options.labels ?? null);
			},
			getContractData: async () => {
				if (options.baseTracker) {
					return await withConcurrency(options.baseTracker, baseDelay, options.etherscan ?? null);
				}
				return await delay(baseDelay, options.etherscan ?? null);
			},
		},
		goplus: {
			getTokenSecurity: async () => {
				if (options.baseTracker) {
					return await withConcurrency(options.baseTracker, baseDelay, {
						data: options.token ?? null,
					});
				}
				return await delay(baseDelay, { data: options.token ?? null });
			},
		},
		proxy: {
			isContract: async () => true,
			detectProxy: async () => {
				if (options.baseTracker) {
					return await withConcurrency(
						options.baseTracker,
						baseDelay,
						options.proxy ?? { is_proxy: false },
					);
				}
				return await delay(baseDelay, options.proxy ?? { is_proxy: false });
			},
		},
		sourcify: {
			checkVerification: async (address: string) => {
				const normalized = address.toLowerCase();
				if (implAddress && normalized === implAddress) {
					if (options.implTracker) {
						return await withConcurrency(
							options.implTracker,
							baseDelay,
							options.sourcifyImpl ?? {
								verified: false,
								verificationKnown: false,
							},
						);
					}
					return await delay(
						baseDelay,
						options.sourcifyImpl ?? {
							verified: false,
							verificationKnown: false,
						},
					);
				}
				if (options.baseTracker) {
					return await withConcurrency(options.baseTracker, baseDelay, options.sourcifyMain);
				}
				return await delay(baseDelay, options.sourcifyMain);
			},
		},
	};
}

const ADDRESS = "0x0000000000000000000000000000000000000001";
const CHAIN: Chain = "ethereum";
const CONFIG: Config = { etherscanKeys: { ethereum: "test" } };

describe("analyzer parallel execution (unit)", () => {
	test("runs post-RPC providers with bounded parallelism", async () => {
		const tracker = createTracker();
		const deps = createDeps({
			baseTracker: tracker,
			sourcifyMain: { verified: false, verificationKnown: false },
			labels: null,
			etherscan: null,
			defillama: null,
			proxy: { is_proxy: false },
			token: null,
			delayMs: 25,
		});

		const progressEvents: Array<{ provider: string; status: string }> = [];

		await analyze(
			ADDRESS,
			CHAIN,
			CONFIG,
			(event) => {
				progressEvents.push({ provider: event.provider, status: event.status });
			},
			{ deps },
		);

		expect(tracker.maxInFlight).toBeGreaterThan(1);
		expect(tracker.maxInFlight).toBeLessThanOrEqual(3);

		const terminalCounts = new Map<string, number>();
		for (const event of progressEvents) {
			if (event.status === "start") continue;
			const current = terminalCounts.get(event.provider) ?? 0;
			terminalCounts.set(event.provider, current + 1);
		}

		expect(terminalCounts.get("Sourcify")).toBe(1);
		expect(terminalCounts.get("Etherscan Labels")).toBe(1);
		expect(terminalCounts.get("Etherscan")).toBe(1);
		expect(terminalCounts.get("Proxy")).toBe(1);
		expect(terminalCounts.get("DeFiLlama")).toBe(1);
		expect(terminalCounts.get("GoPlus")).toBe(1);
	});

	test("preserves deterministic findings regardless provider completion order", async () => {
		const slowSourcifyDeps = createDeps({
			sourcifyMain: {
				verified: true,
				verificationKnown: true,
				name: "Sourcify Alpha",
			},
			labels: { labels: [] },
			etherscan: {
				verified: true,
				name: "Etherscan Beta",
				age_days: 5,
				tx_count: 50,
			},
			defillama: { name: "Uniswap" },
			proxy: { is_proxy: false },
			token: null,
			delayMs: 30,
		});

		const fastDeps = createDeps({
			sourcifyMain: {
				verified: true,
				verificationKnown: true,
				name: "Sourcify Alpha",
			},
			labels: { labels: [] },
			etherscan: {
				verified: true,
				name: "Etherscan Beta",
				age_days: 5,
				tx_count: 50,
			},
			defillama: { name: "Uniswap" },
			proxy: { is_proxy: false },
			token: null,
			delayMs: 1,
		});

		const slowResult = await analyze(ADDRESS, CHAIN, CONFIG, undefined, { deps: slowSourcifyDeps });
		const fastResult = await analyze(ADDRESS, CHAIN, CONFIG, undefined, { deps: fastDeps });

		expect(slowResult.findings).toEqual(fastResult.findings);
		expect(slowResult.recommendation).toBe(fastResult.recommendation);
		expect(slowResult.contract.proxy_name).toBe("Sourcify Alpha");
		expect(slowResult.contract.name).toBe("Sourcify Alpha");
	});

	test("parallelizes proxy implementation follow-ups when both are needed", async () => {
		const implTracker = createTracker();
		const implementation = "0x00000000000000000000000000000000000000aa";
		const deps = createDeps({
			sourcifyMain: {
				verified: false,
				verificationKnown: true,
			},
			sourcifyImpl: {
				verified: true,
				verificationKnown: true,
				name: "Implementation V1",
			},
			labels: null,
			etherscan: null,
			defillama: null,
			defillamaImpl: { name: "Aave" },
			proxy: {
				is_proxy: true,
				implementation,
				proxy_type: "uups",
			},
			token: null,
			implTracker,
			delayMs: 35,
		});

		const result = await analyze(ADDRESS, CHAIN, CONFIG, undefined, { deps });

		expect(implTracker.maxInFlight).toBeGreaterThan(1);
		expect(implTracker.maxInFlight).toBeLessThanOrEqual(2);
		expect(result.contract.implementation_name).toBe("Implementation V1");
	});
});
