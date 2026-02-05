import { nowMs } from "../timing";

export interface AnvilForkConfig {
	forkUrl: string;
	forkBlock?: number;
}

export interface AnvilResetClient {
	snapshot: () => Promise<unknown>;
	revert: (args: { id: string }) => Promise<unknown>;
	request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

export interface WarmResetResult {
	baselineSnapshotId: string;
	usedAnvilReset: boolean;
	ms: number;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

async function takeSnapshot(client: AnvilResetClient): Promise<string> {
	const value = await client.snapshot();
	if (!isNonEmptyString(value)) {
		throw new Error("Anvil snapshot returned invalid id");
	}
	return value;
}

async function revertToSnapshot(client: AnvilResetClient, id: string): Promise<void> {
	const result = await client.revert({ id });
	if (typeof result === "boolean" && result === false) {
		throw new Error("Anvil revert failed");
	}
}

async function anvilReset(client: AnvilResetClient, fork: AnvilForkConfig): Promise<void> {
	const forking: Record<string, unknown> = {
		jsonRpcUrl: fork.forkUrl,
	};
	if (typeof fork.forkBlock === "number" && Number.isFinite(fork.forkBlock)) {
		forking.blockNumber = Math.trunc(fork.forkBlock);
	}
	await client.request({
		method: "anvil_reset",
		params: [{ forking }],
	});
}

export async function warmResetAnvilFork(options: {
	client: AnvilResetClient;
	fork: AnvilForkConfig;
	baselineSnapshotId: string | null;
}): Promise<WarmResetResult> {
	const started = nowMs();
	const client = options.client;
	const fork = options.fork;

	if (!options.baselineSnapshotId) {
		const baselineSnapshotId = await takeSnapshot(client);
		return {
			baselineSnapshotId,
			usedAnvilReset: false,
			ms: nowMs() - started,
		};
	}

	let usedAnvilReset = false;
	try {
		await revertToSnapshot(client, options.baselineSnapshotId);
	} catch {
		usedAnvilReset = true;
		await anvilReset(client, fork);
	}

	const baselineSnapshotId = await takeSnapshot(client);
	return {
		baselineSnapshotId,
		usedAnvilReset,
		ms: nowMs() - started,
	};
}
