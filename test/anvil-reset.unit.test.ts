import { describe, expect, test } from "bun:test";
import { warmResetAnvilFork } from "../src/simulations/anvil-reset";

function createClient(options?: {
	snapshotIds?: string[];
	revertBehavior?: "ok" | "false" | "throw";
}) {
	const snapshotIds = options?.snapshotIds ?? ["0x1", "0x2", "0x3"];
	let snapshotIndex = 0;
	const calls: Array<{ method: string; params?: unknown[] }> = [];

	return {
		client: {
			snapshot: async () => {
				const value = snapshotIds[snapshotIndex] ?? `0x${snapshotIndex + 1}`;
				snapshotIndex += 1;
				return value;
			},
			revert: async (_args: { id: string }) => {
				if (options?.revertBehavior === "throw") {
					throw new Error("revert failed");
				}
				if (options?.revertBehavior === "false") {
					return false;
				}
				return true;
			},
			request: async (args: { method: string; params?: unknown[] }) => {
				calls.push({ method: args.method, params: args.params });
				return null;
			},
		},
		calls,
	};
}

describe("warmResetAnvilFork", () => {
	test("baseline null: takes a snapshot", async () => {
		const { client, calls } = createClient();
		const result = await warmResetAnvilFork({
			client,
			fork: { forkUrl: "http://example.invalid" },
			baselineSnapshotId: null,
		});
		expect(result.usedAnvilReset).toBe(false);
		expect(result.baselineSnapshotId).toBe("0x1");
		expect(calls).toEqual([]);
	});

	test("baseline set + revert ok: reverts then snapshots", async () => {
		const { client, calls } = createClient({
			snapshotIds: ["0xaaa", "0xbbb"],
			revertBehavior: "ok",
		});
		const result = await warmResetAnvilFork({
			client,
			fork: { forkUrl: "http://example.invalid" },
			baselineSnapshotId: "0xdead",
		});
		expect(result.usedAnvilReset).toBe(false);
		expect(result.baselineSnapshotId).toBe("0xaaa");
		expect(calls).toEqual([]);
	});

	test("revert returns false: falls back to anvil_reset", async () => {
		const { client, calls } = createClient({ snapshotIds: ["0x10"], revertBehavior: "false" });
		const result = await warmResetAnvilFork({
			client,
			fork: { forkUrl: "http://rpc.local", forkBlock: 123 },
			baselineSnapshotId: "0xdead",
		});
		expect(result.usedAnvilReset).toBe(true);
		expect(result.baselineSnapshotId).toBe("0x10");
		expect(calls.length).toBe(1);
		expect(calls[0]?.method).toBe("anvil_reset");
		const params = calls[0]?.params;
		expect(Array.isArray(params)).toBe(true);
		const first = Array.isArray(params) ? params[0] : null;
		expect(first).toEqual({
			forking: {
				jsonRpcUrl: "http://rpc.local",
				blockNumber: 123,
			},
		});
	});
});
