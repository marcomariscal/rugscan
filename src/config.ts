import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AllowlistConfig, Chain, Config, SimulationConfig } from "./types";

const VALID_CHAINS: Chain[] = ["ethereum", "base", "arbitrum", "optimism", "polygon"];

export const DEFAULT_USER_CONFIG_PATH = path.join(os.homedir(), ".config", "assay", "config.json");

const DEFAULT_CONFIG_PATHS = [
	path.resolve(process.cwd(), "assay.config.json"),
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
	const explicitPath = process.env.ASSAY_CONFIG;
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
	const explicitPath = process.env.ASSAY_CONFIG;
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
	const sharedEtherscanKey = process.env.ETHERSCAN_API_KEY;
	return {
		etherscanKeys: {
			ethereum: sharedEtherscanKey,
			base: process.env.BASESCAN_API_KEY ?? sharedEtherscanKey,
			arbitrum: process.env.ARBISCAN_API_KEY ?? sharedEtherscanKey,
			optimism: process.env.OPTIMISM_API_KEY ?? sharedEtherscanKey,
			polygon: process.env.POLYGONSCAN_API_KEY ?? sharedEtherscanKey,
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
		simulation: mergeSimulationConfig(base.simulation, override.simulation),
		allowlist: mergeAllowlistConfig(base.allowlist, override.allowlist),
	};
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
	// Guard: avoid treating empty/all-invalid arrays as an enabled deny-all allowlist.
	return parsed.length > 0 ? parsed : undefined;
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
