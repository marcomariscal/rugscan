import { describe, expect, test } from "bun:test";
import { buildPlainEthTransferIntent, isPlainEthTransfer } from "../src/calldata/plain-transfer";

describe("plain ETH transfer detection", () => {
	test("isPlainEthTransfer: empty data + positive value", () => {
		expect(isPlainEthTransfer({ data: "0x", value: "467381751583766000" })).toBe(true);
	});

	test("isPlainEthTransfer: missing data + positive value", () => {
		expect(isPlainEthTransfer({ value: "1000000000000000000" })).toBe(true);
	});

	test("isPlainEthTransfer: empty data + zero value", () => {
		expect(isPlainEthTransfer({ data: "0x", value: "0" })).toBe(false);
	});

	test("isPlainEthTransfer: has calldata + positive value", () => {
		expect(isPlainEthTransfer({ data: "0x095ea7b3", value: "100" })).toBe(false);
	});

	test("isPlainEthTransfer: undefined input", () => {
		expect(isPlainEthTransfer(undefined)).toBe(false);
	});

	test("buildPlainEthTransferIntent: formats amount correctly", () => {
		const intent = buildPlainEthTransferIntent({
			to: "0x9d1115f12dd1a5ca910c5aff70245ec38c7f1117",
			data: "0x",
			value: "467381751583766000",
		});
		expect(intent).toBe("Send 0.4674 ETH to 0x9d1115f12dd1a5ca910c5aff70245ec38c7f1117");
	});

	test("buildPlainEthTransferIntent: returns null for non-transfer", () => {
		const intent = buildPlainEthTransferIntent({
			to: "0x9d1115f12dd1a5ca910c5aff70245ec38c7f1117",
			data: "0x095ea7b3",
			value: "100",
		});
		expect(intent).toBeNull();
	});

	test("buildPlainEthTransferIntent: returns null for zero value", () => {
		const intent = buildPlainEthTransferIntent({
			to: "0x9d1115f12dd1a5ca910c5aff70245ec38c7f1117",
			data: "0x",
			value: "0",
		});
		expect(intent).toBeNull();
	});
});
