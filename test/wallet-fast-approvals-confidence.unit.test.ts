import { describe, expect, test } from "bun:test";
import { encodeFunctionData } from "viem";
import { simulateWithAnvilWalletFast } from "../src/simulations/balance";

describe("wallet-fast approvals confidence", () => {
	test("does not downgrade approvals confidence when budget is exhausted with no approval events", async () => {
		const from = "0x1111111111111111111111111111111111111111";
		const to = "0x2222222222222222222222222222222222222222";
		const receipt = {
			status: "success",
			blockNumber: 100n,
			gasUsed: 21_000n,
			effectiveGasPrice: 1n,
			logs: [],
		};
		const client = {
			getBalance: async () => 1_000_000n,
			sendUnsignedTransaction: async () => "0xabc",
			waitForTransactionReceipt: async () => receipt,
			readContract: async () => 0n,
			call: async () => null,
		};

		const result = await simulateWithAnvilWalletFast({
			tx: {
				to,
				from,
				data: "0x",
				value: "0",
				chain: "ethereum",
			},
			client,
			from,
			to,
			data: "0x",
			txValue: 0n,
			notes: [],
			balanceConfidence: "high",
			approvalsConfidence: "high",
			budgetMs: 0,
		});

		expect(result.approvals.changes).toEqual([]);
		expect(result.approvals.confidence).toBe("high");
		expect(result.notes).toContain(
			"Wallet-fast budget (0ms) reached; skipped ERC-20 metadata lookups.",
		);
		expect(
			result.notes.some((note) =>
				note.includes("reached before approval state reads; using event-derived approvals"),
			),
		).toBe(false);
	});

	test("decodes approve calldata into structured approval diffs even when budget is exhausted", async () => {
		const from = "0x1111111111111111111111111111111111111111";
		const token = "0x2222222222222222222222222222222222222222";
		const spender = "0x3333333333333333333333333333333333333333";
		const approveData = encodeFunctionData({
			abi: [
				{
					type: "function",
					name: "approve",
					stateMutability: "nonpayable",
					inputs: [
						{ name: "spender", type: "address" },
						{ name: "amount", type: "uint256" },
					],
					outputs: [{ name: "", type: "bool" }],
				},
			],
			functionName: "approve",
			args: [spender, 500n],
		});

		const receipt = {
			status: "success",
			blockNumber: 100n,
			gasUsed: 42_000n,
			effectiveGasPrice: 1n,
			logs: [],
		};
		const client = {
			getBalance: async () => 1_000_000n,
			sendUnsignedTransaction: async () => "0xabc",
			waitForTransactionReceipt: async () => receipt,
			readContract: async (args: { functionName: string; blockNumber?: bigint }) => {
				if (args.functionName === "allowance") {
					if (args.blockNumber === 99n) return 0n;
					if (args.blockNumber === 100n) return 500n;
				}
				if (args.functionName === "symbol") return "MOCK";
				if (args.functionName === "decimals") return 18;
				return 0n;
			},
			call: async () => null,
		};

		const result = await simulateWithAnvilWalletFast({
			tx: {
				to: token,
				from,
				data: approveData,
				value: "0",
				chain: "ethereum",
			},
			client,
			from,
			to: token,
			data: approveData,
			txValue: 0n,
			notes: [],
			balanceConfidence: "high",
			approvalsConfidence: "high",
			senderIsContract: true,
			budgetMs: 0,
		});

		expect(result.approvals.changes).toHaveLength(1);
		const approval = result.approvals.changes[0];
		expect(approval.standard).toBe("erc20");
		expect(approval.token.toLowerCase()).toBe(token.toLowerCase());
		expect(approval.spender.toLowerCase()).toBe(spender.toLowerCase());
		expect(approval.previousAmount).toBe(0n);
		expect(approval.amount).toBe(500n);
		expect(result.approvals.confidence).toBe("high");
		// Balance confidence is "medium" because budgetMs=0 triggers metadata skip,
		// but the contract-sender heuristic itself did NOT downgrade (observable deltas present).
		expect(result.balances.confidence).toBe("medium");
		expect(
			result.notes.some((note) =>
				note.includes(
					"Contract sender had observable balance/approval deltas; confidence not downgraded.",
				),
			),
		).toBe(true);
	});
});
