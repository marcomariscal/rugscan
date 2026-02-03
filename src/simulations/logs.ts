import type { Log } from "viem";
import {
	type Abi,
	type AbiEvent,
	type Address,
	decodeEventLog,
	getEventSelector,
	type Hex,
	isAddress,
} from "viem";
import { toBigInt } from "../analyzers/calldata/utils";
import type { ConfidenceLevel } from "../types";

export interface ParsedTransfer {
	standard: "erc20" | "erc721" | "erc1155";
	token: Address;
	from: Address;
	to: Address;
	amount?: bigint;
	tokenId?: bigint;
	operator?: Address;
	logIndex: number;
}

export interface ParsedApproval {
	standard: "erc20" | "erc721" | "erc1155";
	token: Address;
	owner: Address;
	spender: Address;
	amount?: bigint;
	tokenId?: bigint;
	scope?: "token" | "all";
	approved?: boolean;
	logIndex: number;
}

export interface ParsedLogResult {
	transfers: ParsedTransfer[];
	approvals: ParsedApproval[];
	notes: string[];
	confidence: ConfidenceLevel;
}

export interface ReadContractClient {
	readContract: (args: {
		address: Address;
		abi: Abi;
		functionName: string;
		args?: readonly unknown[];
	}) => Promise<unknown>;
}

const ERC721_INTERFACE_ID = "0x80ac58cd";
const ERC1155_INTERFACE_ID = "0xd9b67a26";

const TRANSFER_EVENT: AbiEvent = {
	anonymous: false,
	type: "event",
	name: "Transfer",
	inputs: [
		{ indexed: true, name: "from", type: "address" },
		{ indexed: true, name: "to", type: "address" },
		{ indexed: false, name: "value", type: "uint256" },
	],
};

const APPROVAL_EVENT_ERC20: AbiEvent = {
	anonymous: false,
	type: "event",
	name: "Approval",
	inputs: [
		{ indexed: true, name: "owner", type: "address" },
		{ indexed: true, name: "spender", type: "address" },
		{ indexed: false, name: "value", type: "uint256" },
	],
};

const APPROVAL_EVENT_ERC721: AbiEvent = {
	anonymous: false,
	type: "event",
	name: "Approval",
	inputs: [
		{ indexed: true, name: "owner", type: "address" },
		{ indexed: true, name: "approved", type: "address" },
		{ indexed: true, name: "tokenId", type: "uint256" },
	],
};

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

const TRANSFER_SINGLE_EVENT: AbiEvent = {
	anonymous: false,
	type: "event",
	name: "TransferSingle",
	inputs: [
		{ indexed: true, name: "operator", type: "address" },
		{ indexed: true, name: "from", type: "address" },
		{ indexed: true, name: "to", type: "address" },
		{ indexed: false, name: "id", type: "uint256" },
		{ indexed: false, name: "value", type: "uint256" },
	],
};

const TRANSFER_BATCH_EVENT: AbiEvent = {
	anonymous: false,
	type: "event",
	name: "TransferBatch",
	inputs: [
		{ indexed: true, name: "operator", type: "address" },
		{ indexed: true, name: "from", type: "address" },
		{ indexed: true, name: "to", type: "address" },
		{ indexed: false, name: "ids", type: "uint256[]" },
		{ indexed: false, name: "values", type: "uint256[]" },
	],
};

const ERC165_ABI: Abi = [
	{
		type: "function",
		name: "supportsInterface",
		stateMutability: "view",
		inputs: [{ name: "interfaceId", type: "bytes4" }],
		outputs: [{ name: "", type: "bool" }],
	},
];

const TRANSFER_ABI: Abi = [TRANSFER_EVENT];
const APPROVAL_ERC20_ABI: Abi = [APPROVAL_EVENT_ERC20];
const APPROVAL_ERC721_ABI: Abi = [APPROVAL_EVENT_ERC721];
const APPROVAL_FOR_ALL_ABI: Abi = [APPROVAL_FOR_ALL_EVENT];
const TRANSFER_SINGLE_ABI: Abi = [TRANSFER_SINGLE_EVENT];
const TRANSFER_BATCH_ABI: Abi = [TRANSFER_BATCH_EVENT];

const TRANSFER_TOPIC = getEventSelector(TRANSFER_EVENT);
const APPROVAL_ERC20_TOPIC = getEventSelector(APPROVAL_EVENT_ERC20);
const APPROVAL_ERC721_TOPIC = getEventSelector(APPROVAL_EVENT_ERC721);
const APPROVAL_FOR_ALL_TOPIC = getEventSelector(APPROVAL_FOR_ALL_EVENT);
const TRANSFER_SINGLE_TOPIC = getEventSelector(TRANSFER_SINGLE_EVENT);
const TRANSFER_BATCH_TOPIC = getEventSelector(TRANSFER_BATCH_EVENT);

export async function parseReceiptLogs(
	logs: Log[],
	client: ReadContractClient,
): Promise<ParsedLogResult> {
	const transfers: ParsedTransfer[] = [];
	const approvals: ParsedApproval[] = [];
	const notes: string[] = [];
	let confidence: ConfidenceLevel = "high";
	const erc721Cache = new Map<Address, boolean | null>();
	const erc1155Cache = new Map<Address, boolean | null>();

	const rawTransfers: {
		token: Address;
		from: Address;
		to: Address;
		value: bigint;
		logIndex: number;
	}[] = [];

	for (const log of logs) {
		const topic = log.topics[0];
		if (!topic) continue;

		if (topic === TRANSFER_TOPIC) {
			const decoded = decodeLog(TRANSFER_ABI, log, "Transfer");
			const from = getAddressArg(decoded?.args, "from");
			const to = getAddressArg(decoded?.args, "to");
			const value = getBigIntArg(decoded?.args, "value");
			if (!from || !to || value === null) continue;
			rawTransfers.push({ token: log.address, from, to, value, logIndex: log.logIndex });
			continue;
		}

		if (topic === APPROVAL_ERC20_TOPIC) {
			const decoded = decodeLog(APPROVAL_ERC20_ABI, log, "Approval");
			const owner = getAddressArg(decoded?.args, "owner");
			const spender = getAddressArg(decoded?.args, "spender");
			const value = getBigIntArg(decoded?.args, "value");
			if (!owner || !spender || value === null) continue;
			approvals.push({
				standard: "erc20",
				token: log.address,
				owner,
				spender,
				amount: value,
				logIndex: log.logIndex,
			});
			continue;
		}

		if (topic === APPROVAL_ERC721_TOPIC) {
			const decoded = decodeLog(APPROVAL_ERC721_ABI, log, "Approval");
			const owner = getAddressArg(decoded?.args, "owner");
			const approved = getAddressArg(decoded?.args, "approved");
			const tokenId = getBigIntArg(decoded?.args, "tokenId");
			if (!owner || !approved || tokenId === null) continue;
			approvals.push({
				standard: "erc721",
				token: log.address,
				owner,
				spender: approved,
				tokenId,
				scope: "token",
				logIndex: log.logIndex,
			});
			continue;
		}

		if (topic === APPROVAL_FOR_ALL_TOPIC) {
			const decoded = decodeLog(APPROVAL_FOR_ALL_ABI, log, "ApprovalForAll");
			const owner = getAddressArg(decoded?.args, "owner");
			const operator = getAddressArg(decoded?.args, "operator");
			const approved = getBoolArg(decoded?.args, "approved");
			if (!owner || !operator || approved === null) continue;
			const standard = await resolveApprovalForAllStandard(
				client,
				erc721Cache,
				erc1155Cache,
				log.address,
				notes,
				() => {
					confidence = "low";
				},
			);
			approvals.push({
				standard,
				token: log.address,
				owner,
				spender: operator,
				scope: "all",
				approved,
				logIndex: log.logIndex,
			});
			continue;
		}

		if (topic === TRANSFER_SINGLE_TOPIC) {
			const decoded = decodeLog(TRANSFER_SINGLE_ABI, log, "TransferSingle");
			const operator = getAddressArg(decoded?.args, "operator");
			const from = getAddressArg(decoded?.args, "from");
			const to = getAddressArg(decoded?.args, "to");
			const id = getBigIntArg(decoded?.args, "id");
			const value = getBigIntArg(decoded?.args, "value");
			if (!operator || !from || !to || id === null || value === null) continue;
			transfers.push({
				standard: "erc1155",
				token: log.address,
				operator,
				from,
				to,
				tokenId: id,
				amount: value,
				logIndex: log.logIndex,
			});
			continue;
		}

		if (topic === TRANSFER_BATCH_TOPIC) {
			const decoded = decodeLog(TRANSFER_BATCH_ABI, log, "TransferBatch");
			const operator = getAddressArg(decoded?.args, "operator");
			const from = getAddressArg(decoded?.args, "from");
			const to = getAddressArg(decoded?.args, "to");
			const ids = getBigIntArrayArg(decoded?.args, "ids");
			const values = getBigIntArrayArg(decoded?.args, "values");
			if (!operator || !from || !to || !ids || !values) continue;
			const pairs = Math.min(ids.length, values.length);
			for (let index = 0; index < pairs; index += 1) {
				const tokenId = ids[index];
				const amount = values[index];
				if (tokenId === undefined || amount === undefined) continue;
				transfers.push({
					standard: "erc1155",
					token: log.address,
					operator,
					from,
					to,
					tokenId,
					amount,
					logIndex: log.logIndex,
				});
			}
		}
	}

	for (const transfer of rawTransfers) {
		const supports = await resolveErc721Support(client, erc721Cache, transfer.token, notes);
		if (supports === null) {
			confidence = "low";
		}
		if (supports) {
			transfers.push({
				standard: "erc721",
				token: transfer.token,
				from: transfer.from,
				to: transfer.to,
				tokenId: transfer.value,
				logIndex: transfer.logIndex,
			});
			continue;
		}
		transfers.push({
			standard: "erc20",
			token: transfer.token,
			from: transfer.from,
			to: transfer.to,
			amount: transfer.value,
			logIndex: transfer.logIndex,
		});
	}

	return {
		transfers,
		approvals,
		notes,
		confidence,
	};
}

async function resolveErc721Support(
	client: ReadContractClient,
	cache: Map<Address, boolean | null>,
	address: Address,
	notes: string[],
): Promise<boolean | null> {
	const cached = cache.get(address);
	if (cached !== undefined) return cached;
	const supports = await supportsInterface(client, address, ERC721_INTERFACE_ID);
	if (supports === null) {
		notes.push(`ERC-165 check failed for ${address}; defaulted to ERC-20`);
	}
	cache.set(address, supports);
	return supports;
}

async function resolveApprovalForAllStandard(
	client: ReadContractClient,
	erc721Cache: Map<Address, boolean | null>,
	erc1155Cache: Map<Address, boolean | null>,
	address: Address,
	notes: string[],
	markLowConfidence: () => void,
): Promise<"erc721" | "erc1155"> {
	const erc721 = await resolveErc721Support(client, erc721Cache, address, notes);
	if (erc721 === true) return "erc721";
	const erc1155 = await resolveErc1155Support(client, erc1155Cache, address, notes);
	if (erc1155 === true) return "erc1155";
	if (erc721 === null || erc1155 === null) {
		markLowConfidence();
		notes.push(`ERC-165 check failed for ${address}; defaulted to ERC-721 ApprovalForAll`);
	}
	return "erc721";
}

async function resolveErc1155Support(
	client: ReadContractClient,
	cache: Map<Address, boolean | null>,
	address: Address,
	notes: string[],
): Promise<boolean | null> {
	const cached = cache.get(address);
	if (cached !== undefined) return cached;
	const supports = await supportsInterface(client, address, ERC1155_INTERFACE_ID);
	if (supports === null) {
		notes.push(`ERC-165 check failed for ${address}; unable to confirm ERC-1155`);
	}
	cache.set(address, supports);
	return supports;
}

async function supportsInterface(
	client: ReadContractClient,
	address: Address,
	interfaceId: Hex,
): Promise<boolean | null> {
	try {
		const result = await client.readContract({
			address,
			abi: ERC165_ABI,
			functionName: "supportsInterface",
			args: [interfaceId],
		});
		return typeof result === "boolean" ? result : null;
	} catch {
		return null;
	}
}

function decodeLog(abi: Abi, log: Log, eventName: string) {
	try {
		return decodeEventLog({
			abi,
			eventName,
			data: log.data,
			topics: log.topics,
		});
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getAddressArg(args: unknown, key: string): Address | null {
	if (!isRecord(args)) return null;
	const value = args[key];
	if (typeof value !== "string") return null;
	if (!isAddress(value)) return null;
	return value;
}

function getBigIntArg(args: unknown, key: string): bigint | null {
	if (!isRecord(args)) return null;
	const value = args[key];
	const parsed = toBigInt(value);
	return parsed;
}

function getBigIntArrayArg(args: unknown, key: string): bigint[] | null {
	if (!isRecord(args)) return null;
	const value = args[key];
	if (!Array.isArray(value)) return null;
	const parsed: bigint[] = [];
	for (const entry of value) {
		const amount = toBigInt(entry);
		if (amount === null) return null;
		parsed.push(amount);
	}
	return parsed;
}

function getBoolArg(args: unknown, key: string): boolean | null {
	if (!isRecord(args)) return null;
	const value = args[key];
	if (typeof value !== "boolean") return null;
	return value;
}
