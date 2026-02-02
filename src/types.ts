export type Chain = "ethereum" | "base" | "arbitrum" | "optimism" | "polygon";

export type FindingLevel = "danger" | "warning" | "info" | "safe";

export type FindingCode =
	// Danger
	| "UNVERIFIED"
	| "HONEYPOT"
	| "HIDDEN_MINT"
	| "SELFDESTRUCT"
	| "OWNER_DRAIN"
	| "APPROVAL_TARGET_MISMATCH"
	| "APPROVAL_TO_EOA"
	| "POSSIBLE_TYPOSQUAT"
	| "APPROVAL_TO_DANGEROUS_CONTRACT"
	| "KNOWN_PHISHING"
	// Warning
	| "UNKNOWN_SECURITY"
	| "BLACKLIST"
	| "HIGH_TAX"
	| "NEW_CONTRACT"
	| "UPGRADEABLE"
	| "UNLIMITED_APPROVAL"
	| "APPROVAL_TO_UNVERIFIED"
	| "APPROVAL_TO_NEW_CONTRACT"
	// Info
	| "LOW_ACTIVITY"
	| "PROXY"
	| "AI_PARSE_FAILED"
	| "AI_WARNING"
	| "CALLDATA_DECODED"
	| "CALLDATA_UNKNOWN_SELECTOR"
	| "CALLDATA_SIGNATURES"
	| "CALLDATA_EMPTY"
	// Safe
	| "VERIFIED"
	| "KNOWN_PROTOCOL";

export type Recommendation = "danger" | "warning" | "caution" | "ok";

export type ConfidenceLevel = "high" | "medium" | "low";

export type AIRiskLevel = "safe" | "low" | "medium" | "high" | "critical";
export type AIProvider = "anthropic" | "openai" | "openrouter";
export type AIConcernCategory =
	| "reentrancy"
	| "access_control"
	| "upgradeability"
	| "token_security"
	| "oracle"
	| "logic_error"
	| "centralization"
	| "prompt_injection_attempt";

export interface AIConcern {
	title: string;
	severity: "medium" | "high";
	category: AIConcernCategory;
	explanation: string;
	confidence: number;
}

export interface AIAnalysis {
	risk_score: number;
	summary: string;
	concerns: AIConcern[];
	model: string;
	provider: AIProvider;
}

export interface Finding {
	level: FindingLevel;
	code: FindingCode;
	message: string;
	details?: Record<string, unknown>;
	refs?: string[];
}

export interface ContractInfo {
	address: string;
	chain: Chain;
	name?: string;
	verified: boolean;
	age_days?: number;
	tx_count?: number;
	is_proxy: boolean;
	implementation?: string;
	beacon?: string;
}

export interface Confidence {
	level: ConfidenceLevel;
	reasons: string[];
}

export interface AnalysisResult {
	contract: ContractInfo;
	protocol?: string;
	findings: Finding[];
	confidence: Confidence;
	recommendation: Recommendation;
	ai?: AIAnalysis;
}

export interface ApprovalTx {
	token: string;
	spender: string;
	amount: bigint;
}

export interface ApprovalContext {
	expectedSpender?: string;
	calledContract?: string;
}

export interface ApprovalAnalysisResult {
	recommendation: Recommendation;
	findings: Finding[];
	spenderAnalysis: AnalysisResult;
	flags: {
		isUnlimited: boolean;
		targetMismatch: boolean;
		spenderUnverified: boolean;
		spenderNew: boolean;
		possibleTyposquat: boolean;
	};
}

export interface Config {
	etherscanKeys?: Partial<Record<Chain, string>>;
	rpcUrls?: Partial<Record<Chain, string>>;
	ai?: AIConfig;
	aiOptions?: AIOptions;
}

// Provider interfaces
export interface VerificationResult {
	verified: boolean;
	name?: string;
	source?: string;
}

export interface EtherscanData {
	verified: boolean;
	name?: string;
	source?: string;
	age_days?: number;
	tx_count?: number;
	creator?: string;
}

export interface ProtocolMatch {
	name: string;
	tvl?: number;
}

export interface TokenSecurity {
	is_honeypot: boolean | undefined;
	is_mintable: boolean | undefined;
	can_take_back_ownership: boolean | undefined;
	hidden_owner: boolean | undefined;
	selfdestruct: boolean | undefined;
	buy_tax?: number;
	sell_tax?: number;
	is_blacklisted: boolean | undefined;
	owner_can_change_balance: boolean | undefined;
}

export interface ProxyInfo {
	is_proxy: boolean;
	proxy_type?: "eip1967" | "uups" | "beacon" | "minimal" | "unknown";
	implementation?: string;
	beacon?: string;
}

export interface ProviderResult<T> {
	data: T | null;
	error?: string;
}

export interface AIConfig {
	anthropic_api_key?: string;
	openai_api_key?: string;
	openrouter_api_key?: string;
	default_model?: string;
}

export interface AIOptions {
	enabled?: boolean;
	model?: string;
}
