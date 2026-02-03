import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createTestClient, http, publicActions } from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";
import { getChainConfig } from "../chains";
import type { Chain, Config } from "../types";

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
}

const instances = new Map<string, Promise<AnvilInstance>>();

export async function getAnvilClient(chain: Chain, config?: Config): Promise<AnvilInstance> {
	const forkUrl = resolveRpcUrl(chain, config);
	const forkBlock = config?.simulation?.forkBlock;
	const anvilPath = config?.simulation?.anvilPath ?? "anvil";
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
	return (
		config?.simulation?.rpcUrl ??
		config?.rpcUrls?.[chain] ??
		chainConfig.rpcUrl
	);
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
	return {
		client,
		rpcUrl,
		stop: async () => stopProcess(child),
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
