import { describe, expect, test } from "bun:test";
import type { DecodedCall } from "../src/analyzers/calldata/decoder";
import { MAX_UINT160, MAX_UINT256 } from "../src/constants";
import { buildIntent } from "../src/intent";
import { PERMIT2_CANONICAL_ADDRESS } from "../src/permit2";

describe("intent templates", () => {
	test("builds ERC20 approve intent", () => {
		const call: DecodedCall = {
			selector: "0x095ea7b3",
			signature: "approve(address,uint256)",
			functionName: "approve",
			source: "known-abi",
			standard: "erc20",
			args: {
				spender: "0x0000000000000000000000000000000000000001",
				amount: "1000",
			},
		};

		const intent = buildIntent(call, { contractName: "USDC" });
		expect(intent).toBe("Approve 0x0000000000000000000000000000000000000001 to spend 1000 USDC");
	});

	test("builds Aave borrow intent", () => {
		const call: DecodedCall = {
			selector: "0x12345678",
			signature: "borrow(address,uint256,uint256,uint16,address)",
			functionName: "borrow",
			source: "signature-db",
			args: [
				"0x0000000000000000000000000000000000000010",
				"2500",
				"2",
				"0",
				"0x0000000000000000000000000000000000000011",
			],
		};

		const intent = buildIntent(call, {});
		expect(intent).toBe("Borrow 2500 0x0000000000000000000000000000000000000010 from Aave");
	});

	test("builds Aave flashLoanSimple intent with borrow + callback + repay semantics", () => {
		const call: DecodedCall = {
			selector: "0x42b0b77c",
			signature: "flashLoanSimple(address,address,uint256,bytes,uint16)",
			functionName: "flashLoanSimple",
			source: "local-selector",
			args: [
				"0x6e3873408b4814b2da53d46cb7c4a9ea322e778e",
				"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
				"4068055555555555556",
				"0x",
				0,
			],
		};

		const intent = buildIntent(call, {});
		expect(intent).toContain("Aave flashloan");
		expect(intent).toContain("borrow + callback + repay");
	});

	test("formats known token amounts using decimals", () => {
		const call: DecodedCall = {
			selector: "0x095ea7b3",
			signature: "approve(address,uint256)",
			functionName: "approve",
			source: "known-abi",
			standard: "erc20",
			args: {
				spender: "0x0000000000000000000000000000000000000001",
				amount: "500606000",
			},
		};

		const intent = buildIntent(call, {
			contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
		});
		expect(intent).toBe("Approve 0x0000000000000000000000000000000000000001 to spend 500.61 USDC");
	});

	test("builds Universal Router execute intent from decoded command plan", () => {
		const call: DecodedCall = {
			selector: "0x3593564c",
			signature: "execute(bytes,bytes[],uint256)",
			functionName: "execute",
			source: "local-selector",
			args: {
				commands: "0x0b1004",
				commandsDecoded: [
					{ index: 0, opcode: "0x0b", command: "WRAP_ETH", allowRevert: false },
					{ index: 1, opcode: "0x10", command: "V4_SWAP", allowRevert: false },
					{ index: 2, opcode: "0x04", command: "SWEEP", allowRevert: false },
				],
			},
		};

		const intent = buildIntent(call, {});
		expect(intent).toBe("Uniswap Universal Router: WRAP_ETH → V4_SWAP → SWEEP");
	});

	test("summarizes multicall inner intents", () => {
		const call: DecodedCall = {
			selector: "0xac9650d8",
			signature: "multicall(bytes[])",
			functionName: "multicall",
			source: "local-selector",
			args: {
				callCount: 2,
				innerCalls: [{ functionName: "exactInputSingle" }, { functionName: "unwrapWETH9" }],
			},
		};

		const intent = buildIntent(call, {});
		expect(intent).toBe("multicall: exactInputSingle + unwrapWETH9");
	});

	test("summarizes Safe execTransaction using inner approve call", () => {
		const call: DecodedCall = {
			selector: "0x6a761202",
			signature:
				"execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
			functionName: "execTransaction",
			source: "local-selector",
			args: {
				to: "0xdac17f958d2ee523a2206206994597c13d831ec7",
				value: "0",
				operation: "0",
				innerCall: {
					functionName: "approve",
					args: {
						spender: "0x000000000022d473030f116ddee9f6b43ac78ba3",
						amount: "3600000617",
					},
				},
			},
		};

		const intent = buildIntent(call, {});
		expect(intent).toBe("Safe exec → USDT approve(Permit2, 3,600)");
	});

	test("humanizes 1inch aggregated swap action", () => {
		const call: DecodedCall = {
			selector: "0x07ed2379",
			signature:
				"swap(address,address,(address,address,address,address,uint256,uint256,uint256),bytes,bytes)",
			functionName: "swap",
			source: "local-selector",
			args: [],
		};

		const intent = buildIntent(call, {
			contractAddress: "0x111111125421ca6dc452d289314280a0f8842a65",
			contractName: "AggregationRouterV6",
		});
		expect(intent).toBe("1inch aggregated swap");
	});

	test("humanizes 1inch uniswapV3Swap action", () => {
		const call: DecodedCall = {
			selector: "0xe449022e",
			signature: "uniswapV3Swap(uint256,uint256,uint256[])",
			functionName: "uniswapV3Swap",
			source: "contract-abi",
			args: {
				amount: "310000000000000000",
				minReturn: "57291080635495902669595",
				pools: ["101158091151877850028968684976255873637166782454"],
			},
		};

		const intent = buildIntent(call, {
			contractAddress: "0x1111111254fb6c44bac0bed2854e76f90643097d",
			contractName: "AggregationRouterV4",
		});
		expect(intent).toBe("1inch swap via Uniswap V3 (1 pool)");
	});

	test("humanizes max uint256 approvals as UNLIMITED", () => {
		const call: DecodedCall = {
			selector: "0x095ea7b3",
			signature: "approve(address,uint256)",
			functionName: "approve",
			source: "known-abi",
			standard: "erc20",
			args: {
				spender: "0x0000000000000000000000000000000000000001",
				amount: MAX_UINT256.toString(),
			},
		};

		const intent = buildIntent(call, {
			contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
		});
		expect(intent).toBe(
			"Approve 0x0000000000000000000000000000000000000001 to spend UNLIMITED USDC",
		);
	});

	test("humanizes setApprovalForAll grant/revoke wording", () => {
		const grantCall: DecodedCall = {
			selector: "0xa22cb465",
			signature: "setApprovalForAll(address,bool)",
			functionName: "setApprovalForAll",
			source: "contract-abi",
			args: {
				operator: "0x0000000000000000000000000000000000000abc",
				approved: true,
			},
		};

		const revokeCall: DecodedCall = {
			...grantCall,
			args: {
				operator: "0x0000000000000000000000000000000000000abc",
				approved: false,
			},
		};

		expect(buildIntent(grantCall, { contractName: "ENS" })).toBe(
			"Grant 0x0000000000000000000000000000000000000abc operator access to all ENS tokens",
		);
		expect(buildIntent(revokeCall, { contractName: "ENS" })).toBe(
			"Revoke 0x0000000000000000000000000000000000000abc operator access to all ENS tokens",
		);
	});

	test("humanizes Circle CCTP depositForBurn", () => {
		const call: DecodedCall = {
			selector: "0x6fd3504e",
			signature: "depositForBurn(uint256,uint32,bytes32,address)",
			functionName: "depositForBurn",
			source: "contract-abi",
			args: {
				amount: "1000000",
				destinationDomain: "32",
				mintRecipient: "0x0000000000000000000000000000000000000000000000000000000000000001",
				burnToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
			},
		};

		const intent = buildIntent(call, {});
		expect(intent).toBe("Bridge 1 USDC via Circle CCTP to domain 32");
	});

	test("humanizes upgradeToAndCall as proxy upgrade", () => {
		const call: DecodedCall = {
			selector: "0x4f1ef286",
			signature: "upgradeToAndCall(address,bytes)",
			functionName: "upgradeToAndCall",
			source: "contract-abi",
			args: {
				newImplementation: "0xa19934ae98d6b6ce0879f2674c58f9cf73344982",
				data: "0x",
			},
		};

		const intent = buildIntent(call, {});
		expect(intent).toBe(
			"Upgrade proxy implementation to 0xa19934ae98d6b6ce0879f2674c58f9cf73344982",
		);
	});

	test("humanizes EntryPoint handleOps as EIP-4337 bundle", () => {
		const call: DecodedCall = {
			selector: "0x1fad948c",
			signature:
				"handleOps((bytes,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes,bytes)[],address)",
			functionName: "handleOps",
			source: "contract-abi",
			args: {
				ops: [{}, {}],
				beneficiary: "0x3cc44c0a462cd4e9c0ab15028f65b353f7df1de8",
			},
		};

		const intent = buildIntent(call, {});
		expect(intent).toBe(
			"EIP-4337: process 2 UserOperations (beneficiary 0x3cc44c0a462cd4e9c0ab15028f65b353f7df1de8)",
		);
	});

	test("humanizes Permit2 approve(token,spender,amount,expiration) with expiry", () => {
		const call: DecodedCall = {
			selector: "0x87517c45",
			signature: "approve(address,address,uint160,uint48)",
			functionName: "approve",
			source: "contract-abi",
			args: {
				token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
				spender: "0x9999999999999999999999999999999999999999",
				amount: MAX_UINT160.toString(),
				expiration: "1735689600",
			},
		};

		const intent = buildIntent(call, {
			contractAddress: PERMIT2_CANONICAL_ADDRESS,
		});
		expect(intent).toBe(
			"Permit2: Allow 0x9999999999999999999999999999999999999999 to spend up to UNLIMITED USDC until 2025-01-01 00:00 UTC",
		);
	});

	test("humanizes transferOwnership as ownership transfer", () => {
		const call: DecodedCall = {
			selector: "0xf2fde38b",
			signature: "transferOwnership(address)",
			functionName: "transferOwnership",
			source: "contract-abi",
			args: {
				newOwner: "0xe2382918fbadbd0e8e8a208bb97f8dcaeab675ae",
			},
		};

		const intent = buildIntent(call, { contractName: "GMNFT" });
		expect(intent).toBe(
			"Transfer contract ownership to 0xe2382918fbadbd0e8e8a208bb97f8dcaeab675ae",
		);
	});

	test("humanizes acceptOwnership as pending ownership acceptance", () => {
		const call: DecodedCall = {
			selector: "0x79ba5097",
			signature: "acceptOwnership()",
			functionName: "acceptOwnership",
			source: "contract-abi",
			args: {},
		};

		const intent = buildIntent(call, {});
		expect(intent).toBe("Accept pending contract ownership");
	});

	test("humanizes Optimism depositETH as bridge action", () => {
		const call: DecodedCall = {
			selector: "0xb1a1a882",
			signature: "depositETH(uint32,bytes)",
			functionName: "depositETH",
			source: "signature-db",
			args: [200000, "0x"],
		};

		const intent = buildIntent(call, {});
		expect(intent).toBe("Bridge ETH to Optimism (L2 gas 200000)");
	});

	test("Aave depositETH still routes to Aave template", () => {
		const call: DecodedCall = {
			selector: "0x474cf53d",
			signature: "depositETH(address,address,uint16)",
			functionName: "depositETH",
			source: "contract-abi",
			args: [
				"0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
				"0xc18080123fa536981e5b984e334c2e5c33179843",
				0,
			],
		};

		const intent = buildIntent(call, {});
		expect(intent).toBe("Supply ETH to Aave");
	});
});
