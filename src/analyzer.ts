import * as defillama from "./providers/defillama";
import * as etherscan from "./providers/etherscan";
import * as goplus from "./providers/goplus";
import * as ai from "./providers/ai";
import * as proxy from "./providers/proxy";
import * as sourcify from "./providers/sourcify";
import { resolveContractName } from "./name-resolution";
import type {
	AnalysisResult,
	Chain,
	Confidence,
	Config,
	ContractInfo,
	Finding,
	ProtocolMatch,
	Recommendation,
	TokenSecurity,
} from "./types";

export async function analyze(
	address: string,
	chain: Chain,
	config?: Config,
	progress?: (event: { provider: string; status: "start" | "success" | "error"; message?: string }) => void,
): Promise<AnalysisResult> {
	const findings: Finding[] = [];
	const confidenceReasons: string[] = [];

	// Normalize address
	const addr = address.toLowerCase();
	const etherscanKey = config?.etherscanKeys?.[chain];
	const rpcUrl = config?.rpcUrls?.[chain];
	const report = progress;

	// 1. Check if it's actually a contract
	report?.({ provider: "RPC", status: "start", message: "checking contract" });
	const isContractAddress = await proxy.isContract(addr, chain, rpcUrl);
	report?.({
		provider: "RPC",
		status: "success",
		message: isContractAddress ? "contract detected" : "not a contract",
	});
	if (!isContractAddress) {
		return {
			contract: {
				address: addr,
				chain,
				verified: false,
				is_proxy: false,
			},
			findings: [
				{
					level: "warning",
					code: "LOW_ACTIVITY",
					message: "Address is not a contract (EOA or empty)",
				},
			],
			confidence: { level: "high", reasons: [] },
			recommendation: "caution",
		};
	}

	// 2. Check verification - Sourcify first (free), then Etherscan
	let verified = false;
	let contractName: string | undefined;
	let source: string | undefined;
	let phishingLabels: string[] = [];
	let phishingNametag: string | undefined;
	let isPhishing = false;
	let implementationName: string | undefined;
	let protocolNameForFriendly: string | undefined;

	report?.({ provider: "Sourcify", status: "start" });
	const sourcifyResult = await sourcify.checkVerification(addr, chain);
	report?.({
		provider: "Sourcify",
		status: "success",
		message: sourcifyResult.verified
			? `verified${sourcifyResult.name ? `: ${sourcifyResult.name}` : ""}`
			: "unverified",
	});
	if (sourcifyResult.verified) {
		verified = true;
		contractName = sourcifyResult.name;
		source = sourcifyResult.source;
	}

	// 2b. Check address labels for phishing/scam
	report?.({ provider: "Etherscan Labels", status: "start" });
	const addressLabels = await etherscan.getAddressLabels(addr, chain, etherscanKey);
	if (addressLabels) {
		phishingLabels = addressLabels.labels;
		phishingNametag = addressLabels.nametag;
		isPhishing =
			(phishingNametag ? containsPhishingKeyword(phishingNametag) : false) ||
			phishingLabels.some(containsPhishingKeyword);
		report?.({
			provider: "Etherscan Labels",
			status: "success",
			message: isPhishing ? "phishing label" : "labels checked",
		});
	} else {
		report?.({ provider: "Etherscan Labels", status: "success", message: "no labels" });
	}

	// 3. Get Etherscan data (if key available)
	let age_days: number | undefined;
	let tx_count: number | undefined;

	if (etherscanKey) {
		report?.({ provider: "Etherscan", status: "start" });
		const etherscanData = await etherscan.getContractData(addr, chain, etherscanKey);
		report?.({
			provider: "Etherscan",
			status: "success",
			message: etherscanData ? "metadata fetched" : "no data",
		});
		if (etherscanData) {
			// Use Etherscan verification if Sourcify didn't have it
			if (!verified && etherscanData.verified) {
				verified = true;
				contractName = contractName || etherscanData.name;
				source = source || etherscanData.source;
			}
			age_days = etherscanData.age_days;
			tx_count = etherscanData.tx_count;
		}
	} else {
		confidenceReasons.push("no etherscan key - limited data");
	}

	// 4. Proxy detection
	report?.({ provider: "Proxy", status: "start" });
	const proxyInfo = await proxy.detectProxy(addr, chain, rpcUrl);
	report?.({
		provider: "Proxy",
		status: "success",
		message: proxyInfo.is_proxy ? `proxy: ${proxyInfo.proxy_type ?? "unknown"}` : "no proxy",
	});

	// 5. Protocol matching
	report?.({ provider: "DeFiLlama", status: "start" });
	const protocolMatch = await defillama.matchProtocol(addr, chain);
	const protocolLabel = formatProtocolLabel(protocolMatch);
	report?.({
		provider: "DeFiLlama",
		status: "success",
		message: protocolMatch ? protocolMatch.name : "no match",
	});
	protocolNameForFriendly = protocolMatch?.name;

	// 5b. Resolve implementation metadata for proxies
	if (proxyInfo.is_proxy && proxyInfo.implementation) {
		report?.({ provider: "Sourcify (impl)", status: "start" });
		const implementationResult = await sourcify.checkVerification(proxyInfo.implementation, chain);
		report?.({
			provider: "Sourcify (impl)",
			status: "success",
			message: implementationResult.verified
				? `verified${implementationResult.name ? `: ${implementationResult.name}` : ""}`
				: "unverified",
		});
		if (implementationResult.verified) {
			implementationName = implementationResult.name;
		}

		if (!protocolNameForFriendly) {
			report?.({ provider: "DeFiLlama (impl)", status: "start" });
			const implementationProtocol = await defillama.matchProtocol(
				proxyInfo.implementation,
				chain,
			);
			report?.({
				provider: "DeFiLlama (impl)",
				status: "success",
				message: implementationProtocol ? implementationProtocol.name : "no match",
			});
			if (implementationProtocol) {
				protocolNameForFriendly = implementationProtocol.name;
			}
		}
	}

	// 6. Token security (if it's a token)
	report?.({ provider: "GoPlus", status: "start" });
	const tokenSecurityResult = await goplus.getTokenSecurity(addr, chain);
	const tokenSecurity = tokenSecurityResult.data;
	const tokenFindingCount = countTokenFindings(tokenSecurity);
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
			message: tokenSecurity
				? `${tokenFindingCount} ${tokenFindingCount === 1 ? "finding" : "findings"}`
				: "no data",
		});
	}

	// Build findings
	if (!verified) {
		findings.push({
			level: "danger",
			code: "UNVERIFIED",
			message: "Source code not verified - cannot analyze contract logic",
		});
	} else {
		findings.push({
			level: "safe",
			code: "VERIFIED",
			message: `Source code verified${contractName ? `: ${contractName}` : ""}`,
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

	// Determine confidence level
	let confidenceLevel: Confidence["level"] = "high";
	if (!verified) {
		confidenceLevel = "low";
		confidenceReasons.push("source not verified");
	} else if (!etherscanKey) {
		confidenceLevel = "medium";
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
		age_days,
		tx_count,
		is_proxy: proxyInfo.is_proxy,
		implementation: proxyInfo.implementation,
		beacon: proxyInfo.beacon,
	};

	let aiAnalysis = undefined;
	if (config?.aiOptions?.enabled) {
		report?.({ provider: "AI", status: "start" });
		try {
			const aiResult = await ai.analyzeRisk(
				{
					contract,
					findings,
					proxy: proxyInfo,
					tokenSecurity,
					protocol: protocolMatch?.name,
					source,
				},
				config.ai,
				config.aiOptions,
			);
			if (aiResult.warning) {
				findings.push({
					level: "info",
					code: "AI_PARSE_FAILED",
					message: aiResult.warning,
				});
			}
			if (aiResult.warnings) {
				for (const warning of aiResult.warnings) {
					findings.push({
						level: "info",
						code: "AI_WARNING",
						message: `AI output warning: ${warning}`,
					});
				}
			}
			if (aiResult.analysis) {
				aiAnalysis = aiResult.analysis;
				report?.({
					provider: "AI",
					status: "success",
					message: `${aiResult.analysis.provider}:${aiResult.analysis.model}`,
				});
			} else {
				report?.({ provider: "AI", status: "success", message: "no output" });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "AI analysis failed";
			report?.({ provider: "AI", status: "error", message });
			throw error;
		}
	}

	return {
		contract,
		protocol: protocolLabel,
		protocolMatch: protocolMatch ?? undefined,
		findings,
		confidence: {
			level: confidenceLevel,
			reasons: confidenceReasons,
		},
		recommendation,
		ai: aiAnalysis,
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
		normalized.includes("phishing") ||
		normalized.includes("scam") ||
		normalized.includes("phish")
	);
}
