import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderHeading, renderResultBox } from "../src/cli/ui";
import { OUTPUT_MATRIX_SCENARIOS } from "./fixtures/output-matrix/scenarios";

const fixturesDir = path.join(import.meta.dir, "fixtures", "output-matrix");

function stripAnsi(input: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("output text matrix (high-leverage scenarios)", () => {
	for (const scenario of OUTPUT_MATRIX_SCENARIOS) {
		test(`${scenario.id}: ${scenario.label}`, async () => {
			const rendered = `${renderHeading(`Tx scan on ${scenario.analysis.contract.chain}`)}\n\n${renderResultBox(scenario.analysis, scenario.context)}\n`;
			const actual = stripAnsi(rendered);
			const expectedPath = path.join(fixturesDir, scenario.id, "rendered.txt");
			const expected = stripAnsi(await readFile(expectedPath, "utf-8"));

			expect(actual).toBe(expected);
			for (const assertion of scenario.keyAssertions) {
				expect(actual).toContain(assertion);
			}
		});
	}
});
