import { describe, expect, test } from "bun:test";
import { buildAnalyzeResponse } from "../src/scan";
import { analyzeResponseSchema, scanInputSchema } from "../src/schema";
import type { AnalysisResult } from "../src/types";

describe("schema", () => {
	const address = "0x1111111111111111111111111111111111111111";
	const calldata = {
		to: "0x2222222222222222222222222222222222222222",
		data: "0x1234abcd",
		value: "0",
		chain: "1",
	};

	test("ScanInput accepts address", () => {
		const result = scanInputSchema.safeParse({ address });
		expect(result.success).toBe(true);
	});

	test("ScanInput accepts calldata", () => {
		const result = scanInputSchema.safeParse({ calldata });
		expect(result.success).toBe(true);
	});

	test("ScanInput rejects missing input", () => {
		const result = scanInputSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	test("ScanInput rejects both address and calldata", () => {
		const result = scanInputSchema.safeParse({ address, calldata });
		expect(result.success).toBe(false);
	});

	test("AnalyzeResponse validates expected shape", () => {
		const response = {
			requestId: "00000000-0000-4000-8000-000000000000",
			scan: {
				input: { address },
				recommendation: "ok",
				confidence: 0.9,
				findings: [
					{
						code: "VERIFIED",
						severity: "ok",
						message: "Source code verified",
					},
				],
				contract: {
					address,
					chain: "ethereum",
					isContract: true,
					verifiedSource: true,
				},
			},
		};
		const result = analyzeResponseSchema.safeParse(response);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.schemaVersion).toBe(1);
		}
	});

	test("AnalyzeResponse JSON output includes schemaVersion=1", () => {
		const requestId = "00000000-0000-4000-8000-000000000000";
		const address = "0x1111111111111111111111111111111111111111";

		const analysis: AnalysisResult = {
			contract: {
				address,
				chain: "ethereum",
				verified: true,
				is_proxy: false,
			},
			findings: [],
			confidence: { level: "high", reasons: [] },
			recommendation: "ok",
		};

		const response = buildAnalyzeResponse({ address }, analysis, requestId);
		const parsed = JSON.parse(JSON.stringify(response));
		expect(parsed.schemaVersion).toBe(1);
	});
});
