import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTestClient, http, publicActions } from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";
import { getChainConfig } from "../chains";
import type { Chain, Config } from "../types";
import { warmResetAnvilFork } from "./anvil-reset";

const VIEM_CHAINS = {
	ethereum: mainnet,
	base: base,
	arbitrum: arbitrum,
	optimism: optimism,
	polygon: polygon,
};

export class AnvilUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnvilUnavailableError";
	}
}

const ANVIL_STARTUP_RETRIES = 50;
const ANVIL_STARTUP_DELAY_MS = 120;

type AnvilClient = ReturnType<typeof createAnvilClient>;

export interface AnvilInstance {
	client: AnvilClient;
	rpcUrl: string;
	stop: () => Promise<void>;
	resetFork: () => Promise<{ usedAnvilReset: boolean; ms: number }>;
	runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
}

const instances = new Map<string, Promise<AnvilInstance>>();

export async function getAnvilClient(chain: Chain, config?: Config): Promise<AnvilInstance> {
	const forkUrl = resolveRpcUrl(chain, config);
	const forkBlock = config?.simulation?.forkBlock;
	const resolved = resolveAnvilExecutable(config);
	if (resolved.kind === "missing") {
		throw new AnvilUnavailableError(buildAnvilNotFoundMessage(resolved.searched));
	}
	const anvilPath = resolved.anvilPath;
	const key = `${chain}:${forkUrl}:${forkBlock ?? "latest"}`;
	const existing = instances.get(key);
	if (existing) return existing;

	const instancePromise = spawnAnvil({ chain, forkUrl, forkBlock, anvilPath }).catch((error) => {
		instances.delete(key);
		throw error;
	});
	instances.set(key, instancePromise);
	return instancePromise;
}

function resolveRpcUrl(chain: Chain, config?: Config): string {
	const chainConfig = getChainConfig(chain);
	return config?.simulation?.rpcUrl ?? config?.rpcUrls?.[chain] ?? chainConfig.rpcUrl;
}

async function spawnAnvil(options: {
	chain: Chain;
	forkUrl: string;
	forkBlock?: number;
	anvilPath: string;
}): Promise<AnvilInstance> {
	const port = await getAvailablePort();
	const rpcUrl = `http://127.0.0.1:${port}`;
	const chainConfig = getChainConfig(options.chain);

	const args: string[] = [
		"--fork-url",
		options.forkUrl,
		"--port",
		`${port}`,
		"--chain-id",
		`${chainConfig.chainId}`,
		"--silent",
	];
	if (options.forkBlock !== undefined) {
		args.push("--fork-block-number", `${options.forkBlock}`);
	}

	const child = spawn(options.anvilPath, args, {
		stdio: "ignore",
	});

	const startError = await waitForProcessStart(child, options.anvilPath, rpcUrl, options.chain);
	if (startError) {
		throw startError;
	}

	const client = createAnvilClient(rpcUrl, options.chain);

	let queue: Promise<void> = Promise.resolve();
	let baselineSnapshotId: string | null = null;
	const fork = { forkUrl: options.forkUrl, forkBlock: options.forkBlock };

	function runExclusive<T>(task: () => Promise<T>): Promise<T> {
		const next = queue.then(task, task);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async function resetFork(): Promise<{ usedAnvilReset: boolean; ms: number }> {
		const result = await warmResetAnvilFork({
			client,
			fork,
			baselineSnapshotId,
		});
		baselineSnapshotId = result.baselineSnapshotId;
		return { usedAnvilReset: result.usedAnvilReset, ms: result.ms };
	}

	return {
		client,
		rpcUrl,
		stop: async () => stopProcess(child),
		resetFork,
		runExclusive,
	};
}

function createAnvilClient(rpcUrl: string, chain: Chain) {
	return createTestClient({
		chain: VIEM_CHAINS[chain],
		mode: "anvil",
		transport: http(rpcUrl),
	}).extend(publicActions);
}

async function waitForProcessStart(
	child: ReturnType<typeof spawn>,
	anvilPath: string,
	rpcUrl: string,
	chain: Chain,
): Promise<Error | null> {
	const failure = new Promise<Error>((resolve) => {
		child.once("error", (error) => {
			if (isSpawnNotFound(error)) {
				resolve(new AnvilUnavailableError(`Anvil not found at ${anvilPath}`));
				return;
			}
			resolve(error instanceof Error ? error : new Error("Failed to start anvil"));
		});
		child.once("exit", (code) => {
			if (code === 0) return;
			resolve(new Error(`Anvil exited with code ${code ?? "unknown"}`));
		});
	});

	const ready = waitForRpc(rpcUrl, chain);
	const result = await Promise.race([failure, ready]);
	if (result instanceof Error) return result;
	return null;
}

async function waitForRpc(rpcUrl: string, chain: Chain): Promise<true> {
	const client = createAnvilClient(rpcUrl, chain);
	for (let attempt = 0; attempt < ANVIL_STARTUP_RETRIES; attempt += 1) {
		try {
			await client.getBlockNumber();
			return true;
		} catch {
			await delay(ANVIL_STARTUP_DELAY_MS);
		}
	}
	throw new Error("Timed out waiting for anvil RPC to start");
}

function isSpawnNotFound(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if (!("code" in error)) return false;
	return error.code === "ENOENT";
}

async function getAvailablePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address === "object" && address && "port" in address) {
				const { port } = address;
				server.close(() => resolve(port));
				return;
			}
			server.close(() => reject(new Error("Failed to allocate port")));
		});
	});
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.killed) return;
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.kill();
	});
}

type ResolvedAnvilExecutable =
	| { kind: "explicit"; anvilPath: string }
	| { kind: "auto"; anvilPath: string }
	| { kind: "missing"; searched: AnvilSearchInfo };

interface AnvilSearchInfo {
	searchedOnPath: boolean;
	checkedPaths: string[];
}

function resolveAnvilExecutable(config?: Config): ResolvedAnvilExecutable {
	const explicit = config?.simulation?.anvilPath;
	if (explicit) {
		return { kind: "explicit", anvilPath: explicit };
	}

	const searchedOnPath = Boolean(process.env.PATH);
	const fromPath = findExecutableOnPath("anvil");
	if (fromPath) {
		return { kind: "auto", anvilPath: fromPath };
	}

	const checkedPaths = buildDefaultAnvilCandidates(resolveHomeDir());
	for (const candidate of checkedPaths) {
		if (existsSync(candidate)) {
			return { kind: "auto", anvilPath: candidate };
		}
	}

	return {
		kind: "missing",
		searched: {
			searchedOnPath,
			checkedPaths,
		},
	};
}

function resolveHomeDir(): string {
	const home = process.env.HOME;
	if (home && home.trim().length > 0) {
		return home;
	}
	const userProfile = process.env.USERPROFILE;
	if (userProfile && userProfile.trim().length > 0) {
		return userProfile;
	}
	return os.homedir();
}

function buildDefaultAnvilCandidates(homeDir: string): string[] {
	if (!homeDir) return [];
	return [path.join(homeDir, ".foundry", "bin", "anvil")];
}

function buildAnvilNotFoundMessage(search: AnvilSearchInfo): string {
	const parts: string[] = [];
	if (search.searchedOnPath) {
		parts.push('searched for "anvil" on PATH');
	}
	if (search.checkedPaths.length > 0) {
		parts.push(`checked: ${search.checkedPaths.join(", ")}`);
	}
	const suffix = parts.length > 0 ? ` (${parts.join("; ")})` : "";
	return `Anvil not found${suffix}`;
}

function findExecutableOnPath(command: string): string | null {
	const pathValue = process.env.PATH;
	if (!pathValue) return null;
	const dirs = splitPathList(pathValue);
	if (dirs.length === 0) return null;

	const extensions = executableExtensions();
	for (const dir of dirs) {
		for (const ext of extensions) {
			const candidate = path.join(dir, `${command}${ext}`);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

function splitPathList(value: string): string[] {
	return value
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function executableExtensions(): string[] {
	if (process.platform !== "win32") return [""];
	const pathext = process.env.PATHEXT;
	if (pathext) {
		const entries = pathext
			.split(";")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		if (entries.length > 0) {
			return entries;
		}
	}
	return [".EXE", ".CMD", ".BAT", ".COM"];
}
