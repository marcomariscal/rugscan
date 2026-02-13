import type { Chain } from "../types";

export interface KnownSpender {
	name: string;
	address: string;
}

export const KNOWN_SPENDERS: Record<Chain, KnownSpender[]> = {
	ethereum: [
		{
			name: "Uniswap V2 Router",
			address: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
		},
		{
			name: "Uniswap V3 SwapRouter",
			address: "0xe592427a0aece92de3edee1f18e0157c05861564",
		},
		{
			name: "Uniswap V3 SwapRouter02",
			address: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
		},
		{
			name: "Uniswap Universal Router",
			address: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
		},
		{
			name: "Uniswap Permit2",
			address: "0x000000000022d473030f116ddee9f6b43ac78ba3",
		},
		{
			name: "SushiSwap Router",
			address: "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f",
		},
		{
			name: "1inch Router",
			address: "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
		},
	],
	base: [
		{
			name: "Seamless ILM Router",
			address: "0xb0764de7eef0ac69855c431334b7bc51a96e6dba",
		},
		{
			name: "Uniswap V2 Router",
			address: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
		},
		{
			name: "Uniswap V3 SwapRouter02",
			address: "0x2626664c2603336e57b271c5c0b26f421741e481",
		},
		{
			name: "Uniswap Universal Router",
			address: "0x6ff5693b99212da76ad316178a184ab56d299b43",
		},
		{
			name: "Uniswap Permit2",
			address: "0x000000000022d473030f116ddee9f6b43ac78ba3",
		},
		{
			name: "QuickSwap V2 Router",
			address: "0x4a012af2b05616fb390ed32452641c3f04633bb5",
		},
	],
	arbitrum: [
		{
			name: "Uniswap V2 Router",
			address: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
		},
		{
			name: "Uniswap V3 SwapRouter",
			address: "0xe592427a0aece92de3edee1f18e0157c05861564",
		},
		{
			name: "Uniswap V3 SwapRouter02",
			address: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
		},
		{
			name: "Uniswap Universal Router",
			address: "0xa51afafe0263b40edaef0df8781ea9aa03e381a3",
		},
		{
			name: "Uniswap Permit2",
			address: "0x000000000022d473030f116ddee9f6b43ac78ba3",
		},
	],
	optimism: [
		{
			name: "Uniswap V2 Router",
			address: "0x4a7b5da61326a6379179b40d00f57e5bbdc962c2",
		},
		{
			name: "Uniswap V3 SwapRouter",
			address: "0xe592427a0aece92de3edee1f18e0157c05861564",
		},
		{
			name: "Uniswap V3 SwapRouter02",
			address: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
		},
		{
			name: "Uniswap Universal Router",
			address: "0x851116d9223fabed8e56c0e6b8ad0c31d98b3507",
		},
		{
			name: "Uniswap Permit2",
			address: "0x000000000022d473030f116ddee9f6b43ac78ba3",
		},
		{
			name: "SushiSwap Router",
			address: "0x2abf469074dc0b54d793850807e6eb5faf2625b1",
		},
	],
	polygon: [
		{
			name: "Uniswap V2 Router",
			address: "0xedf6066a2b290c185783862c7f4776a2c8077ad1",
		},
		{
			name: "Uniswap V3 SwapRouter",
			address: "0xe592427a0aece92de3edee1f18e0157c05861564",
		},
		{
			name: "Uniswap V3 SwapRouter02",
			address: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
		},
		{
			name: "Uniswap Universal Router",
			address: "0x1095692a6237d83c6a72f3f5efedb9a670c49223",
		},
		{
			name: "Uniswap Permit2",
			address: "0x000000000022d473030f116ddee9f6b43ac78ba3",
		},
		{
			name: "SushiSwap Router",
			address: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
		},
		{
			name: "QuickSwap V2 Router",
			address: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
		},
	],
};
