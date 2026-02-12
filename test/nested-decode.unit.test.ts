import { describe, expect, test } from "bun:test";
import { analyzeCalldata } from "../src/analyzers/calldata";
import { isRecord } from "../src/analyzers/calldata/utils";

describe("nested call decoding", () => {
	test("multicall(bytes[]) decodes inner calls for V3 SwapRouter", async () => {
		const fixture = await Bun.file(
			`${import.meta.dir}/fixtures/txs/uniswap-v3-swaprouter-multicall-695c6606.json`,
		).text();
		const parsed = JSON.parse(fixture);
		const result = await analyzeCalldata({ to: parsed.to, data: parsed.data }, undefined, {
			offline: true,
		});

		const decoded = result.findings.find((f) => f.code === "CALLDATA_DECODED");
		expect(decoded).toBeDefined();
		if (!decoded?.details || !isRecord(decoded.details)) return;
		expect(decoded.details.functionName).toBe("multicall");

		const args = decoded.details.args;
		expect(isRecord(args)).toBe(true);
		if (!isRecord(args)) return;

		expect(Array.isArray(args.innerCalls)).toBe(true);
		if (!Array.isArray(args.innerCalls)) return;

		expect(args.innerCalls.length).toBe(2);
		const names = args.innerCalls.map((c: unknown) => (isRecord(c) ? c.functionName : null));
		expect(names).toEqual(["exactInputSingle", "unwrapWETH9"]);
	});

	test("Safe execTransaction decodes inner approve call", async () => {
		const fixture = await Bun.file(
			`${import.meta.dir}/fixtures/txs/gnosis-safe-exec-usdt-approve-ed42563e.json`,
		).text();
		const parsed = JSON.parse(fixture);
		const result = await analyzeCalldata({ to: parsed.to, data: parsed.data }, undefined, {
			offline: true,
		});

		const decoded = result.findings.find((f) => f.code === "CALLDATA_DECODED");
		expect(decoded).toBeDefined();
		if (!decoded?.details || !isRecord(decoded.details)) return;
		expect(decoded.details.functionName).toBe("execTransaction");

		const args = decoded.details.args;
		expect(isRecord(args)).toBe(true);
		if (!isRecord(args)) return;

		const innerCall = args.innerCall;
		expect(isRecord(innerCall)).toBe(true);
		if (!isRecord(innerCall)) return;

		expect(innerCall.functionName).toBe("approve");
		expect(isRecord(innerCall.args)).toBe(true);
		if (!isRecord(innerCall.args)) return;
		expect(innerCall.args.spender).toBe("0x000000000022d473030f116ddee9f6b43ac78ba3");
	});
});
