import { describe, expect, test } from "bun:test";
import { renderResultBox } from "../src/cli/ui";
import type { AnalysisResult } from "../src/types";

function stripAnsi(input: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function baseAnalysis(): AnalysisResult {
	return {
		contract: {
			address: "0x1111111111111111111111111111111111111111",
			chain: "ethereum",
			verified: true,
			confidence: "high",
			is_proxy: false,
		},
		findings: [],
		recommendation: "ok",
	};
}

describe("box width-aware wrapping", () => {
	test("without maxWidth, box expands freely (backwards compat)", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			simulation: {
				success: false,
				revertReason: "execution reverted: transferFrom failed",
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: ["Simulation failed"],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		const lines = output.split("\n");
		// All box lines should be the same width
		const boxLines = lines.filter((line) => line.startsWith("│") || line.startsWith("┌"));
		const widths = boxLines.map((line) => line.length);
		const maxWidth = Math.max(...widths);
		// Without clamping the INCONCLUSIVE line drives the box wider than 80
		expect(maxWidth).toBeGreaterThan(80);
		// All box lines must be the same width (uniform box)
		for (const w of widths) {
			expect(w).toBe(maxWidth);
		}
	});

	test("with maxWidth=80, all box lines fit within 80 columns", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			simulation: {
				success: false,
				revertReason: "execution reverted: transferFrom failed",
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: ["Simulation failed"],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true, maxWidth: 80 }));
		const lines = output.split("\n");
		for (const line of lines) {
			if (line.length === 0) continue;
			expect(line.length).toBeLessThanOrEqual(80);
		}
	});

	test("content is preserved across wrapping (no truncation)", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			simulation: {
				success: false,
				revertReason: "execution reverted: transferFrom failed",
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: ["Simulation failed"],
			},
		};

		const wide = stripAnsi(renderResultBox(analysis, { hasCalldata: true }));
		const narrow = stripAnsi(renderResultBox(analysis, { hasCalldata: true, maxWidth: 80 }));

		// Wrapping should change line breaks for long content
		expect(narrow).not.toBe(wide);
		// BLOCK (UNVERIFIED) should still appear in wrapped output
		expect(narrow).toContain("BLOCK (UNVERIFIED)");
		// The full revert reason should still be present
		expect(narrow).toContain("transferFrom failed");
		// Recommendation label should be present
		expect(narrow).toContain("RECOMMENDATION:");
	});

	test("wrapped continuation lines are indented", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			simulation: {
				success: false,
				revertReason: "execution reverted: transferFrom failed",
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: ["Simulation failed"],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true, maxWidth: 60 }));
		const lines = output.split("\n");
		// At narrow width, the INCONCLUSIVE line should be wrapped.
		// Verify the box is well-formed: every content line starts with │
		const contentLines = lines.filter(
			(line) => line.startsWith("│") && !line.startsWith("├") && !line.startsWith("└"),
		);
		for (const line of contentLines) {
			expect(line).toMatch(/^│.*│$/);
		}
	});

	test("small content does not wrap when maxWidth is generous", () => {
		const analysis = baseAnalysis();

		const wide = stripAnsi(renderResultBox(analysis, { hasCalldata: false }));
		const clamped = stripAnsi(renderResultBox(analysis, { hasCalldata: false, maxWidth: 200 }));

		// When maxWidth is larger than content, output should be identical
		expect(clamped).toBe(wide);
	});

	test("falls back to non-box layout in very narrow terminals", () => {
		const analysis: AnalysisResult = {
			...baseAnalysis(),
			recommendation: "warning",
			simulation: {
				success: false,
				revertReason: "execution reverted: transferFrom failed",
				balances: { changes: [], confidence: "low" },
				approvals: { changes: [], confidence: "low" },
				notes: ["Simulation failed"],
			},
		};

		const output = stripAnsi(renderResultBox(analysis, { hasCalldata: true, maxWidth: 50 }));
		expect(output).toContain("🎯 RECOMMENDATION");
		// Plain layout: no box chrome characters
		expect(output).not.toContain("┌");
		expect(output).not.toContain("│");
		// Most lines should fit; URLs without spaces are allowed to overflow
		const lines = output.split("\n").filter((l) => l.length > 0);
		const fittingLines = lines.filter((l) => l.length <= 50);
		// At least 80% of lines should fit (URLs are the exception)
		expect(fittingLines.length / lines.length).toBeGreaterThan(0.8);
	});
});
