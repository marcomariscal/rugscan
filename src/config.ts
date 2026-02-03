import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AIConfig, Chain, Config, SimulationConfig } from "./types";

const VALID_CHAINS: Chain[] = ["ethereum", "base", "arbitrum", "optimism", "polygon"];

const DEFAULT_CONFIG_PATHS = [
	path.resolve(process.cwd(), "rugscan.config.json"),
	path.join(os.homedir(), ".config", "rugscan", "config.json"),
];

export async function loadConfig(): Promise<Config> {
	const configPath = resolveConfigPath();
	const fileConfig = configPath ? await readConfigFile(configPath) : {};
	const envConfig = loadEnvConfig();
	return mergeConfig(fileConfig, envConfig);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
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
