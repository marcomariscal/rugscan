export type AnalyzeMode = "default" | "wallet";

export type AnalyzeProviderId =
	| "rpc"
	| "sourcify"
	| "etherscanLabels"
	| "etherscan"
	| "proxy"
	| "defillama"
	| "sourcifyImpl"
	| "defillamaImpl"
	| "goplus";

export interface AnalyzeProviderPolicy {
	enabled: boolean;
	timeoutMs: number;
}

export interface AnalyzePolicy {
	mode: AnalyzeMode;
	/**
	 * Optional overall time budget for the analysis phase.
	 * This is best-effort; providers are also individually timeboxed.
	 */
	budgetMs?: number;
	providers: Record<AnalyzeProviderId, AnalyzeProviderPolicy>;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;

export function createAnalyzePolicy(mode: AnalyzeMode): AnalyzePolicy {
	if (mode === "wallet") {
		return {
			mode,
			budgetMs: 3_000,
			providers: {
				rpc: { enabled: true, timeoutMs: 800 },
				sourcify: { enabled: true, timeoutMs: 1_600 },
				// Etherscan Labels can be very slow (and may fetch large tag exports).
				etherscanLabels: { enabled: false, timeoutMs: 250 },
				// Full Etherscan metadata is helpful but not worth blocking wallet sends.
				etherscan: { enabled: false, timeoutMs: 750 },
				proxy: { enabled: true, timeoutMs: 800 },
				// Keep protocol recognition, but default wallet mode avoids network lookups.
				defillama: { enabled: true, timeoutMs: 250 },
				sourcifyImpl: { enabled: true, timeoutMs: 1_000 },
				defillamaImpl: { enabled: true, timeoutMs: 200 },
				goplus: { enabled: false, timeoutMs: 600 },
			},
		};
	}

	return {
		mode,
		providers: {
			rpc: { enabled: true, timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
			sourcify: { enabled: true, timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
			etherscanLabels: { enabled: true, timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
			etherscan: { enabled: true, timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
			proxy: { enabled: true, timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
			defillama: { enabled: true, timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
			sourcifyImpl: { enabled: true, timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
			defillamaImpl: { enabled: true, timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
			goplus: { enabled: true, timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
		},
	};
}
