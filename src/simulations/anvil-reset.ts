import type { EIP1193RequestFn, Quantity, TestRpcSchema } from "viem";
import { nowMs } from "../timing";

export interface AnvilForkConfig {
	forkUrl: string;
	forkBlock?: number;
}

export interface AnvilResetClient {
	snapshot: () => Promise<Quantity>;
	revert: (args: { id: Quantity }) => Promise<unknown>;
	request: EIP1193RequestFn<TestRpcSchema<"anvil">>;
}

export interface WarmResetResult {
	baselineSnapshotId: Quantity;
	usedAnvilReset: boolean;
	ms: number;
}

function isQuantityString(value: unknown): value is Quantity {
	return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
}

async function takeSnapshot(client: AnvilResetClient): Promise<Quantity> {
	const value = await client.snapshot();
	if (!isQuantityString(value)) {
		throw new Error("Anvil snapshot returned invalid id");
	}
	return value;
}

async function revertToSnapshot(client: AnvilResetClient, id: Quantity): Promise<void> {
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
	baselineSnapshotId: Quantity | null;
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
