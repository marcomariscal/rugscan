import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AIConfig, AllowlistConfig, Chain, Config, SimulationConfig } from "./types";

const VALID_CHAINS: Chain[] = ["ethereum", "base", "arbitrum", "optimism", "polygon"];

export const DEFAULT_USER_CONFIG_PATH = path.join(
	os.homedir(),
	".config",
	"rugscan",
	"config.json",
);

const DEFAULT_CONFIG_PATHS = [
	path.resolve(process.cwd(), "rugscan.config.json"),
	DEFAULT_USER_CONFIG_PATH,
];

export async function loadConfig(): Promise<Config> {
	const configPath = resolveConfigPath();
	const fileConfig = configPath ? await readConfigFile(configPath) : {};
	const envConfig = loadEnvConfig();
	return mergeConfig(fileConfig, envConfig);
}

export function resolveUserConfigPathForWrite(): string {
	// Allow tests and power-users to redirect the config path.
	const explicitPath = process.env.RUGSCAN_CONFIG;
	return explicitPath && explicitPath.trim().length > 0 ? explicitPath : DEFAULT_USER_CONFIG_PATH;
}

export async function saveRpcUrl(options: { chain: Chain; rpcUrl: string }): Promise<string> {
	const configPath = resolveUserConfigPathForWrite();
	await mkdir(path.dirname(configPath), { recursive: true });

	const existing = await readJsonRecordIfExists(configPath);
	const next: Record<string, unknown> = { ...existing };

	const rpcUrls: Record<string, unknown> = isRecord(existing.rpcUrls)
		? { ...existing.rpcUrls }
		: {};
	rpcUrls[options.chain] = options.rpcUrl;
	next.rpcUrls = rpcUrls;

	await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	return configPath;
}

function resolveConfigPath(): string | undefined {
	const explicitPath = process.env.RUGSCAN_CONFIG;
	if (explicitPath) {
		if (!existsSync(explicitPath)) {
			throw new Error(`Config file not found at ${explicitPath}`);
		}
		return explicitPath;
	}
	for (const candidate of DEFAULT_CONFIG_PATHS) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function loadEnvConfig(): Config {
	return {
		etherscanKeys: {
			ethereum: process.env.ETHERSCAN_API_KEY,
			base: process.env.BASESCAN_API_KEY,
			arbitrum: process.env.ARBISCAN_API_KEY,
			optimism: process.env.OPTIMISM_API_KEY,
			polygon: process.env.POLYGONSCAN_API_KEY,
		},
		ai: {
			anthropic_api_key: process.env.ANTHROPIC_API_KEY,
			openai_api_key: process.env.OPENAI_API_KEY,
			openrouter_api_key: process.env.OPENROUTER_API_KEY,
		},
	};
}

async function readConfigFile(configPath: string): Promise<Config> {
	const raw = await readFile(configPath, "utf-8");
	const parsed = safeJsonParse(raw);
	if (!parsed) {
		throw new Error(`Invalid JSON in config file: ${configPath}`);
	}
	return parseConfig(parsed);
}

function safeJsonParse(raw: string): unknown | null {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function readJsonRecordIfExists(configPath: string): Promise<Record<string, unknown>> {
	if (!existsSync(configPath)) return {};
	const raw = await readFile(configPath, "utf-8");
	const parsed = safeJsonParse(raw);
	if (!parsed) {
		throw new Error(`Invalid JSON in config file: ${configPath}`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`Config file must contain a JSON object: ${configPath}`);
	}
	return parsed;
}

function parseConfig(value: unknown): Config {
	if (!isRecord(value)) {
		return {};
	}
	const config: Config = {};
	const etherscanKeys = parseChainStringMap(value.etherscanKeys);
	if (etherscanKeys) {
		config.etherscanKeys = etherscanKeys;
	}
	const rpcUrls = parseChainStringMap(value.rpcUrls);
	if (rpcUrls) {
		config.rpcUrls = rpcUrls;
	}
	const ai = parseAIConfig(value.ai);
	if (ai) {
		config.ai = ai;
	}
	const simulation = parseSimulationConfig(value.simulation);
	if (simulation) {
		config.simulation = simulation;
	}
	const allowlist = parseAllowlistConfig(value.allowlist);
	if (allowlist) {
		config.allowlist = allowlist;
	}
	return config;
}

function parseChainStringMap(value: unknown): Partial<Record<Chain, string>> | undefined {
	if (!isRecord(value)) return undefined;
	const map: Partial<Record<Chain, string>> = {};
	let hasValue = false;
	for (const chain of VALID_CHAINS) {
		const candidate = value[chain];
		if (isNonEmptyString(candidate)) {
			map[chain] = candidate;
			hasValue = true;
		}
	}
	return hasValue ? map : undefined;
}

function parseAIConfig(value: unknown): AIConfig | undefined {
	if (!isRecord(value)) return undefined;
	const aiConfig: AIConfig = {};
	if (isNonEmptyString(value.anthropic_api_key)) {
		aiConfig.anthropic_api_key = value.anthropic_api_key;
	}
	if (isNonEmptyString(value.openai_api_key)) {
		aiConfig.openai_api_key = value.openai_api_key;
	}
	if (isNonEmptyString(value.openrouter_api_key)) {
		aiConfig.openrouter_api_key = value.openrouter_api_key;
	}
	if (isNonEmptyString(value.default_model)) {
		aiConfig.default_model = value.default_model;
	}
	return Object.keys(aiConfig).length > 0 ? aiConfig : undefined;
}

function mergeConfig(base: Config, override: Config): Config {
	return {
		etherscanKeys: {
			...base.etherscanKeys,
			...override.etherscanKeys,
		},
		rpcUrls: {
			...base.rpcUrls,
			...override.rpcUrls,
		},
		ai: mergeAIConfig(base.ai, override.ai),
		simulation: mergeSimulationConfig(base.simulation, override.simulation),
		allowlist: mergeAllowlistConfig(base.allowlist, override.allowlist),
	};
}

function mergeAIConfig(base?: AIConfig, override?: AIConfig): AIConfig | undefined {
	if (!base && !override) return undefined;
	const merged: AIConfig = {
		anthropic_api_key: override?.anthropic_api_key ?? base?.anthropic_api_key,
		openai_api_key: override?.openai_api_key ?? base?.openai_api_key,
		openrouter_api_key: override?.openrouter_api_key ?? base?.openrouter_api_key,
		default_model: override?.default_model ?? base?.default_model,
	};
	return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
}

function mergeSimulationConfig(
	base?: SimulationConfig,
	override?: SimulationConfig,
): SimulationConfig | undefined {
	if (!base && !override) return undefined;
	return {
		enabled: override?.enabled ?? base?.enabled,
		backend: override?.backend ?? base?.backend,
		anvilPath: override?.anvilPath ?? base?.anvilPath,
		forkBlock: override?.forkBlock ?? base?.forkBlock,
		rpcUrl: override?.rpcUrl ?? base?.rpcUrl,
	};
}

function mergeAllowlistConfig(
	base?: AllowlistConfig,
	override?: AllowlistConfig,
): AllowlistConfig | undefined {
	if (!base && !override) return undefined;
	const merged: AllowlistConfig = {
		to: override?.to ?? base?.to,
		spenders: override?.spenders ?? base?.spenders,
	};
	return merged.to !== undefined || merged.spenders !== undefined ? merged : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseAllowlistConfig(value: unknown): AllowlistConfig | undefined {
	if (!isRecord(value)) return undefined;
	const to = parseAddressArray(value.to);
	const spenders = parseAddressArray(value.spenders);
	const allowlist: AllowlistConfig = {};
	if (to !== undefined) {
		allowlist.to = to;
	}
	if (spenders !== undefined) {
		allowlist.spenders = spenders;
	}
	return Object.keys(allowlist).length > 0 ? allowlist : undefined;
}

function parseAddressArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const parsed: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed) continue;
		if (!isAddress(trimmed)) continue;
		parsed.push(trimmed.toLowerCase());
	}
	return parsed;
}

function isAddress(value: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parseSimulationConfig(value: unknown): SimulationConfig | undefined {
	if (!isRecord(value)) return undefined;
	const simulation: SimulationConfig = {};
	if (typeof value.enabled === "boolean") {
		simulation.enabled = value.enabled;
	}
	if (value.backend === "anvil" || value.backend === "heuristic") {
		simulation.backend = value.backend;
	}
	if (isNonEmptyString(value.anvilPath)) {
		simulation.anvilPath = value.anvilPath;
	}
	if (typeof value.forkBlock === "number" && Number.isFinite(value.forkBlock)) {
		simulation.forkBlock = Math.trunc(value.forkBlock);
	}
	if (isNonEmptyString(value.rpcUrl)) {
		simulation.rpcUrl = value.rpcUrl;
	}
	return Object.keys(simulation).length > 0 ? simulation : undefined;
}
