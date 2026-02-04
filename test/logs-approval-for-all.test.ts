import { describe, expect, test } from "bun:test";
import { type AbiEvent, encodeAbiParameters, encodeEventTopics, type Log } from "viem";
import { parseReceiptLogs } from "../src/simulations/logs";

const APPROVAL_FOR_ALL_EVENT: AbiEvent = {
	anonymous: false,
	type: "event",
	name: "ApprovalForAll",
	inputs: [
		{ indexed: true, name: "owner", type: "address" },
		{ indexed: true, name: "operator", type: "address" },
		{ indexed: false, name: "approved", type: "bool" },
	],
};

describe("parseReceiptLogs", () => {
	test("captures ERC1155 ApprovalForAll approvals", async () => {
		const token = "0x1000000000000000000000000000000000000001";
		const owner = "0x2000000000000000000000000000000000000002";
		const operator = "0x3000000000000000000000000000000000000003";
		const topics = encodeEventTopics({
			abi: [APPROVAL_FOR_ALL_EVENT],
			eventName: "ApprovalForAll",
			args: {
				owner,
				operator,
				approved: true,
			},
		});
		const data = encodeAbiParameters([{ type: "bool" }], [true]);

		const log = {
			address: token,
			topics,
			data,
			blockNumber: 1n,
			transactionHash: `0x${"11".repeat(32)}`,
			transactionIndex: 0,
			blockHash: `0x${"22".repeat(32)}`,
			logIndex: 0,
			removed: false,
		} satisfies Log;

		const client = {
			readContract: async (args: {
				address: string;
				abi: unknown;
				functionName: string;
				args?: readonly unknown[];
			}) => {
				if (args.functionName !== "supportsInterface") return false;
				const interfaceId = args.args?.[0];
				return interfaceId === "0xd9b67a26";
			},
		};

		const result = await parseReceiptLogs([log], client);
		expect(result.approvals).toHaveLength(1);
		const approval = result.approvals[0];
		expect(approval?.standard).toBe("erc1155");
		expect(approval?.owner).toBe(owner);
		expect(approval?.spender).toBe(operator);
		expect(approval?.scope).toBe("all");
		expect(approval?.approved).toBe(true);
	});
});
