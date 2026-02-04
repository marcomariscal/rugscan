import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Hex, type Log } from "viem";
import { PERMIT2_APPROVAL_EVENT, PERMIT2_CANONICAL_ADDRESS } from "../src/permit2";
import { parseReceiptLogs } from "../src/simulations/logs";

const ZERO_32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("parseReceiptLogs - Permit2", () => {
	test("captures Permit2 Approval events as permit2 approvals", async () => {
		const owner = "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7";
		const token = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
		const spender = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";

		const topics = encodeEventTopics({
			abi: [PERMIT2_APPROVAL_EVENT],
			eventName: "Approval",
			args: { owner, token, spender },
		});
		const data = encodeAbiParameters(
			[
				{ type: "uint160", name: "amount" },
				{ type: "uint48", name: "expiration" },
			],
			[(1n << 160n) - 1n, 0n],
		);

		const log: Log = {
			address: PERMIT2_CANONICAL_ADDRESS,
			topics,
			data,
			logIndex: 0,
			transactionIndex: 0,
			transactionHash: ZERO_32,
			blockHash: ZERO_32,
			blockNumber: 1n,
			removed: false,
		};

		const client = {
			readContract: async () => false,
		};

		const result = await parseReceiptLogs([log], client);
		expect(result.approvals.length).toBe(1);
		const approval = result.approvals[0];
		expect(approval.standard).toBe("permit2");
		expect(approval.owner.toLowerCase()).toBe(owner.toLowerCase());
		expect(approval.token.toLowerCase()).toBe(token.toLowerCase());
		expect(approval.spender.toLowerCase()).toBe(spender.toLowerCase());
		expect(approval.amount).toBe((1n << 160n) - 1n);
		expect(approval.scope).toBe("token");
	});
});
