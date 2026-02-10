import { type AnalyzeMode, type AnalyzeProviderId, createAnalyzePolicy } from "./analyzer-policy";
import { createTimeBudget, runWithTimeout } from "./budget";
import { resolveContractName } from "./name-resolution";
import * as defillama from "./providers/defillama";
import * as etherscan from "./providers/etherscan";
import * as goplus from "./providers/goplus";
import * as proxy from "./providers/proxy";
import type { ProviderRequestOptions } from "./providers/request-options";
import * as sourcify from "./providers/sourcify";
import type {
	AnalysisResult,
	Chain,
	Config,
	ContractInfo,
	Finding,
	ProtocolMatch,
	ProxyInfo,
	Recommendation,
	TokenSecurity,
} from "./types";

export interface AnalyzerDeps {
	defillama: {
		matchProtocol: typeof defillama.matchProtocol;
	};
	etherscan: {
		getAddressLabels: typeof etherscan.getAddressLabels;
		getContractData: typeof etherscan.getContractData;
	};
	goplus: {
		getTokenSecurity: typeof goplus.getTokenSecurity;
	};
	proxy: {
		isContract: typeof proxy.isContract;
		detectProxy: typeof proxy.detectProxy;
	};
	sourcify: {
		checkVerification: typeof sourcify.checkVerification;
	};
}

const DEFAULT_DEPS: AnalyzerDeps = {
	defillama: { matchProtocol: defillama.matchProtocol },
	etherscan: {
		getAddressLabels: etherscan.getAddressLabels,
		getContractData: etherscan.getContractData,
	},
	goplus: { getTokenSecurity: goplus.getTokenSecurity },
	proxy: { isContract: proxy.isContract, detectProxy: proxy.detectProxy },
	sourcify: { checkVerification: sourcify.checkVerification },
};

function isOfflineAllowedProvider(providerId: AnalyzeProviderId): boolean {
	return providerId === "rpc" || providerId === "proxy";
}

export interface AnalyzeOptions {
	mode?: AnalyzeMode;
	deps?: AnalyzerDeps;
	/**
	 * Strict offline mode: only the configured upstream JSON-RPC URL is allowed.
	 * All non-RPC HTTP providers are skipped.
	 */
	offline?: boolean;
}

type ProviderProgress = (event: {
	provider: string;
	status: "start" | "success" | "error";
	message?: string;
}) => void;

type ProviderStep<T> =
	| { status: "skipped"; message: string }
	| { status: "ok"; value: T }
	| { status: "timeout" }
	| { status: "error"; error: unknown };

const MAX_PARALLEL_PROVIDER_CALLS = 3;

async function runTasksWithConcurrencyLimit(
	tasks: Array<() => Promise<void>>,
	limit: number,
): Promise<void> {
	if (tasks.length === 0) return;

	const workerCount = Math.min(Math.max(1, limit), tasks.length);
	let nextTaskIndex = 0;

	const worker = async () => {
		while (nextTaskIndex < tasks.length) {
			const currentIndex = nextTaskIndex;
			nextTaskIndex += 1;
			const task = tasks[currentIndex];
			if (!task) return;
			await task();
		}
	};

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

export async function analyze(
	address: string,
	chain: Chain,
	config?: Config,
	progress?: ProviderProgress,
	options?: AnalyzeOptions,
): Promise<AnalysisResult> {
	const findings: Finding[] = [];

	const deps = options?.deps ?? DEFAULT_DEPS;
	const mode = options?.mode ?? "default";
	const offline = options?.offline ?? false;
	const policy = createAnalyzePolicy(mode);
	const budget = policy.budgetMs ? createTimeBudget(policy.budgetMs) : null;

	const report = progress;

	const resolveTimeoutMs = (providerId: AnalyzeProviderId): number => {
		const providerPolicy = policy.providers[providerId];
		const remaining = budget ? budget.remainingMs() : providerPolicy.timeoutMs;
		return Math.max(0, Math.min(providerPolicy.timeoutMs, remaining));
	};

	const runProvider = async <T>(args: {
		id: AnalyzeProviderId;
		label: string;
		skipMessage: string;
		fn: (req: ProviderRequestOptions) => Promise<T>;
	}): Promise<ProviderStep<T>> => {
		const providerPolicy = policy.providers[args.id];
		report?.({ provider: args.label, status: "start" });

		if (offline && !isOfflineAllowedProvider(args.id)) {
			report?.({ provider: args.label, status: "success", message: "skipped (--offline)" });
			return { status: "skipped", message: "skipped (--offline)" };
		}

		const timeoutMs = resolveTimeoutMs(args.id);
		if (!providerPolicy.enabled) {
			report?.({ provider: args.label, status: "success", message: args.skipMessage });
			return { status: "skipped", message: args.skipMessage };
		}
		if (timeoutMs <= 0) {
			report?.({
				provider: args.label,
				status: "success",
				message: "skipped (budget exhausted)",
			});
			return { status: "skipped", message: "skipped (budget exhausted)" };
		}

		const outcome = await runWithTimeout({ timeoutMs }, async (signal) => {
			return await args.fn({
				signal,
				timeoutMs,
				cache: mode !== "wallet",
			});
		});

		if (outcome.ok) {
			return { status: "ok", value: outcome.value };
		}
		if (outcome.reason === "timeout") {
			report?.({ provider: args.label, status: "error", message: "timeout" });
			return { status: "timeout" };
		}

		const message =
			outcome.error instanceof Error
				? outcome.error.message
				: outcome.reason === "aborted"
					? "aborted"
					: "error";
		report?.({ provider: args.label, status: "error", message });
		return { status: "error", error: outcome.error };
	};

	// Normalize address
	const addr = address.toLowerCase();
	const etherscanKey = config?.etherscanKeys?.[chain];
	const rpcUrl = config?.rpcUrls?.[chain];
	if (offline && !rpcUrl) {
		throw new Error(
			`offline mode: missing config rpcUrls.${chain} (no public RPC fallbacks; set it in assay.config.json or ~/.config/assay/config.json)`,
		);
	}

	// 1. Check if it's actually a contract
	let isContractAddress = true;
	const rpcResult = await runProvider({
		id: "rpc",
		label: "RPC",
		skipMessage: "skipped (--wallet)",
		fn: async () => {
			return await deps.proxy.isContract(addr, chain, rpcUrl);
		},
	});
	if (rpcResult.status === "ok") {
		isContractAddress = rpcResult.value;
		report?.({
			provider: "RPC",
			status: "success",
			message: isContractAddress ? "contract detected" : "not a contract",
		});
	}

	if (!isContractAddress) {
		return {
			contract: {
				address: addr,
				chain,
				verified: false,
				confidence: "high",
				is_proxy: false,
			},
			findings: [
				{
					level: "warning",
					code: "LOW_ACTIVITY",
					message: "Address is not a contract (EOA or empty)",
				},
			],
			recommendation: "caution",
		};
	}

	// 2. Run independent providers in bounded parallel execution
	let verified = false;
	let verificationKnown = false;
	let contractName: string | undefined;
	let source: string | undefined;
	let phishingLabels: string[] = [];
	let phishingNametag: string | undefined;
	let isPhishing = false;
	let implementationName: string | undefined;
	let protocolNameForFriendly: string | undefined;
	let age_days: number | undefined;
	let tx_count: number | undefined;
	let proxyInfo: ProxyInfo = { is_proxy: false };
	let protocolMatch: ProtocolMatch | null = null;
	let protocolLabel: string | undefined;
	let tokenSecurity: TokenSecurity | null = null;

	type SourcifyResult = Awaited<ReturnType<AnalyzerDeps["sourcify"]["checkVerification"]>>;
	type AddressLabelsResult = Awaited<ReturnType<AnalyzerDeps["etherscan"]["getAddressLabels"]>>;
	type EtherscanResult = Awaited<ReturnType<AnalyzerDeps["etherscan"]["getContractData"]>>;
	type ProxyResult = Awaited<ReturnType<AnalyzerDeps["proxy"]["detectProxy"]>>;
	type DefillamaResult = Awaited<ReturnType<AnalyzerDeps["defillama"]["matchProtocol"]>>;
	type GoPlusResult = Awaited<ReturnType<AnalyzerDeps["goplus"]["getTokenSecurity"]>>;

	let sourcifyStep: ProviderStep<SourcifyResult> | undefined;
	let labelsStep: ProviderStep<AddressLabelsResult> | undefined;
	let etherscanStep: ProviderStep<EtherscanResult> | undefined;
	let proxyStep: ProviderStep<ProxyResult> | undefined;
	let defillamaStep: ProviderStep<DefillamaResult> | undefined;
	let goplusStep: ProviderStep<GoPlusResult> | undefined;

	const providerTasks: Array<() => Promise<void>> = [];

	providerTasks.push(async () => {
		const step = await runProvider({
			id: "sourcify",
			label: "Sourcify",
			skipMessage: "skipped (--wallet)",
			fn: async (req) => {
				return await deps.sourcify.checkVerification(addr, chain, req);
			},
		});
		if (step.status === "ok") {
			const sourcifyResult = step.value;
			report?.({
				provider: "Sourcify",
				status: "success",
				message: sourcifyResult.verified
					? `verified${sourcifyResult.name ? `: ${sourcifyResult.name}` : ""}`
					: sourcifyResult.verificationKnown
						? "unverified"
						: "unknown",
			});
		}
		sourcifyStep = step;
	});

	providerTasks.push(async () => {
		const step = await runProvider({
			id: "etherscanLabels",
			label: "Etherscan Labels",
			skipMessage: "skipped (--wallet)",
			fn: async (req) => {
				return await deps.etherscan.getAddressLabels(addr, chain, etherscanKey, req);
			},
		});
		if (step.status === "ok") {
			const addressLabels = step.value;
			if (addressLabels) {
				const nametag = addressLabels.nametag;
				const labels = addressLabels.labels;
				const hasPhishingSignal =
					(nametag ? containsPhishingKeyword(nametag) : false) ||
					labels.some(containsPhishingKeyword);
				report?.({
					provider: "Etherscan Labels",
					status: "success",
					message: hasPhishingSignal ? "phishing label" : "labels checked",
				});
			} else {
				report?.({
					provider: "Etherscan Labels",
					status: "success",
					message: "no labels",
				});
			}
		}
		labelsStep = step;
	});

	if (etherscanKey) {
		providerTasks.push(async () => {
			const step = await runProvider({
				id: "etherscan",
				label: "Etherscan",
				skipMessage: "skipped (--wallet)",
				fn: async (req) => {
					return await deps.etherscan.getContractData(addr, chain, etherscanKey, req);
				},
			});
			if (step.status === "ok") {
				report?.({
					provider: "Etherscan",
					status: "success",
					message: step.value ? "metadata fetched" : "no data",
				});
			}
			etherscanStep = step;
		});
	}

	providerTasks.push(async () => {
		const step = await runProvider({
			id: "proxy",
			label: "Proxy",
			skipMessage: "skipped (--wallet)",
			fn: async () => {
				return await deps.proxy.detectProxy(addr, chain, rpcUrl);
			},
		});
		if (step.status === "ok") {
			report?.({
				provider: "Proxy",
				status: "success",
				message: step.value.is_proxy ? `proxy: ${step.value.proxy_type ?? "unknown"}` : "no proxy",
			});
		}
		proxyStep = step;
	});

	providerTasks.push(async () => {
		const step = await runProvider({
			id: "defillama",
			label: "DeFiLlama",
			skipMessage: "skipped (--wallet)",
			fn: async (req) => {
				return await deps.defillama.matchProtocol(addr, chain, {
					...req,
					allowNetwork: mode !== "wallet",
				});
			},
		});
		if (step.status === "ok") {
			report?.({
				provider: "DeFiLlama",
				status: "success",
				message: step.value?.name ?? (mode === "wallet" ? "manual only" : "no match"),
			});
		}
		defillamaStep = step;
	});

	providerTasks.push(async () => {
		const step = await runProvider({
			id: "goplus",
			label: "GoPlus",
			skipMessage: "skipped (--wallet)",
			fn: async (req) => {
				return await deps.goplus.getTokenSecurity(addr, chain, req);
			},
		});
		if (step.status === "ok") {
			const tokenSecurityResult = step.value;
			const tokenFindingCount = countTokenFindings(tokenSecurityResult.data);
			if (tokenSecurityResult.error) {
				report?.({
					provider: "GoPlus",
					status: "error",
					message: tokenSecurityResult.error,
				});
			} else {
				report?.({
					provider: "GoPlus",
					status: "success",
					message: tokenSecurityResult.data
						? `${tokenFindingCount} ${tokenFindingCount === 1 ? "finding" : "findings"}`
						: "no data",
				});
			}
		}
		goplusStep = step;
	});

	await runTasksWithConcurrencyLimit(providerTasks, MAX_PARALLEL_PROVIDER_CALLS);

	if (sourcifyStep && sourcifyStep.status === "ok") {
		const sourcifyResult = sourcifyStep.value;
		verificationKnown = sourcifyResult.verificationKnown;
		if (sourcifyResult.verified) {
			verified = true;
			contractName = sourcifyResult.name;
			source = sourcifyResult.source;
		}
	}

	if (labelsStep && labelsStep.status === "ok") {
		const addressLabels = labelsStep.value;
		if (addressLabels) {
			phishingLabels = addressLabels.labels;
			phishingNametag = addressLabels.nametag;
			isPhishing =
				(phishingNametag ? containsPhishingKeyword(phishingNametag) : false) ||
				phishingLabels.some(containsPhishingKeyword);
		}
	}

	if (etherscanStep && etherscanStep.status === "ok") {
		const etherscanData = etherscanStep.value;
		if (etherscanData) {
			verificationKnown = true;

			if (!verified && etherscanData.verified) {
				verified = true;
				contractName = contractName || etherscanData.name;
				source = source || etherscanData.source;
			}
			age_days = etherscanData.age_days;
			tx_count = etherscanData.tx_count;
		}
	}

	if (proxyStep && proxyStep.status === "ok") {
		proxyInfo = proxyStep.value;
	}

	if (defillamaStep && defillamaStep.status === "ok") {
		protocolMatch = defillamaStep.value;
		protocolLabel = formatProtocolLabel(protocolMatch);
		protocolNameForFriendly = protocolMatch?.name;
	}

	if (goplusStep && goplusStep.status === "ok") {
		tokenSecurity = goplusStep.value.data;
	}

	// 3. Resolve implementation metadata for proxies
	if (proxyInfo.is_proxy && proxyInfo.implementation) {
		const implementationAddress = proxyInfo.implementation;
		let sourcifyImplStep: ProviderStep<SourcifyResult> | undefined;
		let defillamaImplStep: ProviderStep<DefillamaResult> | undefined;

		const implementationTasks: Array<() => Promise<void>> = [];

		implementationTasks.push(async () => {
			const step = await runProvider({
				id: "sourcifyImpl",
				label: "Sourcify (impl)",
				skipMessage: "skipped (--wallet)",
				fn: async (req) => {
					return await deps.sourcify.checkVerification(implementationAddress, chain, req);
				},
			});
			if (step.status === "ok") {
				const implementationResult = step.value;
				report?.({
					provider: "Sourcify (impl)",
					status: "success",
					message: implementationResult.verified
						? `verified${implementationResult.name ? `: ${implementationResult.name}` : ""}`
						: "unverified",
				});
			}
			sourcifyImplStep = step;
		});

		if (!protocolNameForFriendly) {
			implementationTasks.push(async () => {
				const step = await runProvider({
					id: "defillamaImpl",
					label: "DeFiLlama (impl)",
					skipMessage: "skipped (--wallet)",
					fn: async (req) => {
						return await deps.defillama.matchProtocol(implementationAddress, chain, {
							...req,
							allowNetwork: mode !== "wallet",
						});
					},
				});
				if (step.status === "ok") {
					report?.({
						provider: "DeFiLlama (impl)",
						status: "success",
						message: step.value?.name ?? (mode === "wallet" ? "manual only" : "no match"),
					});
				}
				defillamaImplStep = step;
			});
		}

		await runTasksWithConcurrencyLimit(implementationTasks, 2);

		if (sourcifyImplStep && sourcifyImplStep.status === "ok") {
			const implementationResult = sourcifyImplStep.value;
			if (implementationResult.verified) {
				implementationName = implementationResult.name;
			}
		}

		if (defillamaImplStep && defillamaImplStep.status === "ok") {
			const implementationProtocol = defillamaImplStep.value;
			if (implementationProtocol) {
				protocolNameForFriendly = implementationProtocol.name;
			}
		}
	}

	// Build findings
	if (verified) {
		findings.push({
			level: "safe",
			code: "VERIFIED",
			message: `Source code verified${contractName ? `: ${contractName}` : ""}`,
		});
	} else if (verificationKnown) {
		findings.push({
			level: "danger",
			code: "UNVERIFIED",
			message: "Source code not verified - cannot analyze contract logic",
		});
	} else {
		findings.push({
			level: "info",
			code: "UNKNOWN_SECURITY",
			message: "Verification status unknown (providers skipped/timed out)",
		});
	}

	if (protocolMatch) {
		findings.push({
			level: "safe",
			code: "KNOWN_PROTOCOL",
			message: `Recognized protocol: ${protocolMatch.name}`,
		});
	}

	if (isPhishing) {
		const detail =
			phishingNametag ?? (phishingLabels.length > 0 ? phishingLabels.join(", ") : undefined);
		findings.push({
			level: "danger",
			code: "KNOWN_PHISHING",
			message: `Address labeled as phishing/scam${detail ? `: ${detail}` : ""}`,
		});
	}

	if (proxyInfo.is_proxy) {
		findings.push({
			level: "info",
			code: "PROXY",
			message: `Proxy detected (${proxyInfo.proxy_type ?? "unknown"})`,
		});
		findings.push({
			level: "warning",
			code: "UPGRADEABLE",
			message: `Upgradeable proxy (${proxyInfo.proxy_type}) - code can change`,
		});
	}

	if (age_days !== undefined && age_days < 7) {
		findings.push({
			level: "warning",
			code: "NEW_CONTRACT",
			message: `Contract deployed ${age_days} days ago`,
		});
	}

	if (tx_count !== undefined && tx_count < 100) {
		findings.push({
			level: "info",
			code: "LOW_ACTIVITY",
			message: `Only ${tx_count} transactions`,
		});
	}

	// Token-specific findings
	if (tokenSecurity) {
		if (tokenSecurity.is_honeypot) {
			findings.push({
				level: "danger",
				code: "HONEYPOT",
				message: "Honeypot detected - tokens cannot be sold",
			});
		}
		if (tokenSecurity.is_mintable) {
			findings.push({
				level: "danger",
				code: "HIDDEN_MINT",
				message: "Owner can mint unlimited tokens",
			});
		}
		if (tokenSecurity.selfdestruct) {
			findings.push({
				level: "danger",
				code: "SELFDESTRUCT",
				message: "Contract can self-destruct",
			});
		}
		if (tokenSecurity.owner_can_change_balance) {
			findings.push({
				level: "danger",
				code: "OWNER_DRAIN",
				message: "Owner can modify balances",
			});
		}
		if (tokenSecurity.is_blacklisted) {
			findings.push({
				level: "warning",
				code: "BLACKLIST",
				message: "Contract has blacklist functionality",
			});
		}
		const maxTax = Math.max(tokenSecurity.buy_tax || 0, tokenSecurity.sell_tax || 0);
		if (maxTax > 0.1) {
			findings.push({
				level: "warning",
				code: "HIGH_TAX",
				message: `High transfer tax: ${(maxTax * 100).toFixed(1)}%`,
			});
		}
	}

	// Determine contract confidence level
	let contractConfidence: ContractInfo["confidence"] = "high";
	if (!verified) {
		contractConfidence = verificationKnown ? "low" : "medium";
	} else if (!etherscanKey) {
		contractConfidence = "medium";
	}

	// Determine recommendation
	const recommendation = determineRecommendation(findings);
	const resolvedName = resolveContractName({
		address: addr,
		isProxy: proxyInfo.is_proxy,
		proxyName: contractName,
		implementationName,
		protocolName: protocolNameForFriendly,
	}).resolvedName;

	const contract: ContractInfo = {
		address: addr,
		chain,
		name: resolvedName,
		proxy_name: contractName,
		implementation_name: implementationName,
		verified,
		confidence: contractConfidence,
		age_days,
		tx_count,
		is_proxy: proxyInfo.is_proxy,
		implementation: proxyInfo.implementation,
		beacon: proxyInfo.beacon,
	};

	return {
		contract,
		protocol: protocolLabel,
		protocolMatch: protocolMatch ?? undefined,
		findings,
		recommendation,
	};
}

function countTokenFindings(tokenSecurity: TokenSecurity | null): number {
	if (!tokenSecurity) return 0;
	let count = 0;
	if (tokenSecurity.is_honeypot) count += 1;
	if (tokenSecurity.is_mintable) count += 1;
	if (tokenSecurity.selfdestruct) count += 1;
	if (tokenSecurity.owner_can_change_balance) count += 1;
	if (tokenSecurity.is_blacklisted) count += 1;
	const maxTax = Math.max(tokenSecurity.buy_tax || 0, tokenSecurity.sell_tax || 0);
	if (maxTax > 0.1) count += 1;
	return count;
}

function formatProtocolLabel(match: ProtocolMatch | null): string | undefined {
	if (!match) return undefined;
	const tvl = match.tvl;
	if (tvl === undefined || !Number.isFinite(tvl)) {
		return match.name;
	}
	const formattedTvl = new Intl.NumberFormat("en-US", {
		notation: "compact",
		maximumFractionDigits: 2,
	}).format(tvl);
	return `${match.name} — $${formattedTvl} TVL`;
}

export function determineRecommendation(findings: Finding[]): Recommendation {
	const hasDanger = findings.some((f) => f.level === "danger");
	const hasWarning = findings.some((f) => f.level === "warning");
	const hasSafe = findings.some((f) => f.level === "safe");

	if (hasDanger) {
		return "danger";
	}
	if (hasWarning) {
		return hasSafe ? "caution" : "warning";
	}
	return "ok";
}

function containsPhishingKeyword(value: string): boolean {
	const normalized = value.toLowerCase();
	return (
		normalized.includes("phishing") || normalized.includes("scam") || normalized.includes("phish")
	);
}
