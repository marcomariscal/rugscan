import { describe, expect, test } from "bun:test";
import { analyze } from "../src/analyzer";

describe("analyzer AI findings", () => {
	test(
		"flags AI_PARSE_FAILED and AI_WARNING when AI returns warnings",
		async () => {
		const result = await analyze(
			"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
			"ethereum",
			{
				aiOptions: {
					enabled: true,
					mockResult: {
						warning: "AI response parsing failed; output omitted",
						warnings: ["risk score mismatch"],
					},
				},
			},
		);

		expect(result.findings.some((finding) => finding.code === "AI_PARSE_FAILED")).toBe(
			true,
		);
		expect(result.findings.some((finding) => finding.code === "AI_WARNING")).toBe(true);
		},
		120000,
	);
});
